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

import { HttpException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto, UpdateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';
import { fakeCierre } from '../../common/cierre-mes.fixture-spec';

/**
 * «PAGO DE AFAC» en Gastos (16-oct-2026, API 0.0.89, invariante 90): marca
 * de OFICINA, solo en Permiso, detrás de la sonda `gasto.es_pago_afac`
 * (migración 20261016000005). Harness COPIADO de
 * `expenses.service.tua-incluida.spec` (builder que registra cada consulta);
 * la sonda (`select('es_pago_afac').limit(1)`) responde 42703 con
 * `sinMigracionAfac`. El candado del mes cerrado usa `fakeCierre`.
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
    sinMigracionAfac?: boolean;
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
      if (sel && sel[1][0] === 'es_pago_afac') {
        return opts.sinMigracionAfac
          ? {
              data: null,
              error: {
                code: '42703',
                message: 'column gasto.es_pago_afac does not exist',
              },
            }
          : { data: [], error: null };
      }
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

/** Un PERMISO de octubre (mes abierto) con avión, como los de prod. */
const permiso = (extra: Fila = {}): Fila =>
  gastoActual({
    categoria: 'PERMISO',
    vuelo_id: null,
    monto: '5000.00',
    valor_ia_extraido: null,
    notas: 'Permisos Vuelos Privados VGV · Yousefh Pineda',
    es_pago_afac: false,
    ...extra,
  });

describe('ExpensesService.create — es_pago_afac (invariante 90)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('OFICINA en PERMISO con true ⇒ el insert la lleva y el select la devuelve', async () => {
    for (const rol of [Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR]) {
      const { service, consultas } = armar();
      await service.create(
        alta({
          categoria: CategoriaGasto.PERMISO,
          vuelo_id: undefined,
          aeronave_id: AVION,
          es_pago_afac: true,
        }),
        'u-admin',
        rol,
        { notificar: false },
      );
      expect(cuerpoDe(consultas, 'insert')).toMatchObject({
        es_pago_afac: true,
      });
      expect(selectDe(consultas, 'insert')).toMatch(/, es_pago_afac/);
    }
  });

  it('false (o ausente) ⇒ el payload NO nombra la llave (default de la columna)', async () => {
    const { service, consultas } = armar();
    await service.create(alta({ es_pago_afac: false }), 'u-admin', Rol.ADMIN, {
      notificar: false,
    });
    expect(cuerpoDe(consultas, 'insert')).not.toHaveProperty('es_pago_afac');
  });

  it('true fuera de Permiso ⇒ 400 PAGO_AFAC_SOLO_PERMISO; rol de campo ⇒ 403 PAGO_AFAC_SOLO_OFICINA; sin la migración ⇒ 503; nada se inserta', async () => {
    const a = armar();
    const r400 = await rebote(
      a.service.create(alta({ es_pago_afac: true }), 'u-admin', Rol.ADMIN),
    );
    expect([r400.status, r400.body.error]).toEqual([
      400,
      'PAGO_AFAC_SOLO_PERMISO',
    ]);
    const r403 = await rebote(
      a.service.create(
        alta({ categoria: CategoriaGasto.PERMISO, es_pago_afac: true }),
        'u-piloto',
        Rol.PILOTO,
      ),
    );
    expect([r403.status, r403.body.error]).toEqual([
      403,
      'PAGO_AFAC_SOLO_OFICINA',
    ]);
    expect(conOp(a.consultas, 'insert')).toHaveLength(0);
    const sin = armar({ sinMigracionAfac: true });
    const r503 = await rebote(
      sin.service.create(
        alta({ categoria: CategoriaGasto.PERMISO, es_pago_afac: true }),
        'u-admin',
        Rol.ADMIN,
      ),
    );
    expect([r503.status, r503.body.error]).toEqual([
      503,
      'AFAC_REAL_NO_DISPONIBLE',
    ]);
    // false sin la migración ⇒ se ignora (alta de siempre, sin la columna).
    await sin.service.create(
      alta({ es_pago_afac: false }),
      'u-admin',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(cuerpoDe(sin.consultas, 'insert')).not.toHaveProperty(
      'es_pago_afac',
    );
    expect(selectDe(sin.consultas, 'insert')).not.toMatch(/es_pago_afac/);
  });
});

describe('ExpensesService.update — es_pago_afac (invariante 90)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  const patch = (
    a: ReturnType<typeof armar>,
    dto: UpdateGastoDto,
    rol: Rol = Rol.ADMIN,
  ) => a.service.update(ID, dto, 'u-1', rol);

  it('OFICINA marca un PERMISO ⇒ UPDATE con la llave (también CONCILIADO: no toca dinero del banco)', async () => {
    const a = armar({ actual: permiso({ conciliado: true }), cargos: 1 });
    await patch(a, { es_pago_afac: true });
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      es_pago_afac: true,
    });
  });

  it('marcar un OTRO ⇒ 400; pasarlo a Permiso y marcarlo en el MISMO PATCH ⇒ pasa', async () => {
    const otro = armar({ actual: permiso({ categoria: 'OTRO' }) });
    const r = await rebote(patch(otro, { es_pago_afac: true }));
    expect([r.status, r.body.error]).toEqual([400, 'PAGO_AFAC_SOLO_PERMISO']);
    expect(conOp(otro.consultas, 'update')).toHaveLength(0);
    const ok = armar({ actual: permiso({ categoria: 'OTRO' }) });
    await patch(ok, { categoria: CategoriaGasto.PERMISO, es_pago_afac: true });
    expect(cuerpoDe(ok.consultas, 'update')).toMatchObject({
      categoria: 'PERMISO',
      es_pago_afac: true,
    });
  });

  it('ECO igual al vigente (el diálogo «Verificar» o la app reenvían la fila) ⇒ se ignora: no escribe la llave; solo la marca ⇒ no escribe nada', async () => {
    const a = armar({ actual: permiso({ es_pago_afac: true }) });
    await patch(a, { es_pago_afac: true });
    expect(conOp(a.consultas, 'update')).toHaveLength(0);
    // Un rol de campo con el eco igual NO rebota (403 solo si la CAMBIA).
    const p = armar({ actual: permiso({ es_pago_afac: true }) });
    await patch(p, { es_pago_afac: true, notas: 'del piloto' }, Rol.PILOTO);
    expect(cuerpoDe(p.consultas, 'update')).not.toHaveProperty('es_pago_afac');
    const b = armar({ actual: permiso({ es_pago_afac: true }) });
    await patch(b, { es_pago_afac: true, notas: 'nota nueva' });
    expect(cuerpoDe(b.consultas, 'update')).not.toHaveProperty('es_pago_afac');
    expect(cuerpoDe(b.consultas, 'update')).toMatchObject({
      notas: 'nota nueva',
    });
  });

  it('REVISIÓN: `null` = no tocar (jamás un null sobre la columna NOT NULL); solo null ⇒ no escribe nada', async () => {
    const a = armar({ actual: permiso({ es_pago_afac: true }) });
    await patch(a, {
      es_pago_afac: null as unknown as boolean,
      notas: 'nota nueva',
    });
    expect(cuerpoDe(a.consultas, 'update')).not.toHaveProperty('es_pago_afac');
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      notas: 'nota nueva',
    });
    const b = armar({ actual: permiso({ es_pago_afac: true }) });
    await patch(b, { es_pago_afac: null as unknown as boolean });
    expect(conOp(b.consultas, 'update')).toHaveLength(0);
  });

  it('un rol de campo que la CAMBIA ⇒ 403; sin la migración true ⇒ 503 y false se ignora', async () => {
    const a = armar({ actual: permiso() });
    const r = await rebote(patch(a, { es_pago_afac: true }, Rol.PILOTO));
    expect([r.status, r.body.error]).toEqual([403, 'PAGO_AFAC_SOLO_OFICINA']);
    const sin = armar({ sinMigracionAfac: true, actual: permiso() });
    const r503 = await rebote(patch(sin, { es_pago_afac: true }));
    expect(r503.body.error).toBe('AFAC_REAL_NO_DISPONIBLE');
    await patch(sin, { es_pago_afac: false, notas: 'x' });
    expect(cuerpoDe(sin.consultas, 'update')).not.toHaveProperty(
      'es_pago_afac',
    );
  });
});

describe('ExpensesService — candado MES_CERRADO de la marca (invariante 90 + 89)', () => {
  const ALE = 'u-ale';
  function mundoCierre(): Record<string, Fila[]> {
    return {
      usuario: [{ id: ALE, nombre: 'Ale Martínez', rol: 'ADMIN' }],
      cierre_mes: [
        {
          periodo: '2026-09-01',
          estado: 'CERRADO',
          cerrado_at: '2026-10-16T19:02:00Z',
          cerrado_por: ALE,
          version: 1,
        },
      ],
      vuelo: [],
      gasto: [
        {
          id: 'g-sep',
          categoria: 'PERMISO',
          monto: 5000,
          propina: 0,
          moneda: 'MXN',
          tc_gasto: null,
          fecha_gasto: '2026-09-01',
          medio_pago: 'TRANSFERENCIA',
          vuelo_id: null,
          escala_id: null,
          aeronave_id: AVION,
          conciliado: true,
          compra_id: null,
          notas: null,
          es_pago_afac: false,
          updated_at: '2026-09-01T17:00:00Z',
          usuario_captura_id: ALE,
        },
      ],
    };
  }
  function armarCierre() {
    const f = fakeCierre(mundoCierre());
    const nada = {} as never;
    const service = new ExpensesService(
      f.supabase as unknown as SupabaseService,
      { notifyRole: jest.fn(), notifyUser: jest.fn() } as never,
      nada,
      nada,
      { numero: jest.fn().mockResolvedValue(1) } as never,
      { ultimaReposicionDe: jest.fn().mockResolvedValue(null) } as never,
      nada,
      {
        intentarCruzarGasto: jest.fn().mockResolvedValue({ ligado: false }),
      } as never,
    );
    return { service, f };
  }

  it('marcar / desmarcar un PERMISO de septiembre CERRADO ⇒ 409 MES_CERRADO y no escribe; un eco igual NO dispara el candado', async () => {
    const { service, f } = armarCierre();
    const r = await rebote(
      service.update('g-sep', { es_pago_afac: true }, ALE, Rol.ADMIN),
    );
    expect([r.status, r.body.error]).toEqual([409, 'MES_CERRADO']);
    expect(f.escrituras.filter((e) => e.tabla === 'gasto')).toHaveLength(0);
    await service.update(
      'g-sep',
      { es_pago_afac: false, notas: 'clasificación' },
      ALE,
      Rol.ADMIN,
    );
    expect(f.escrituras.filter((e) => e.tabla === 'gasto')).toHaveLength(1);
  });
});
