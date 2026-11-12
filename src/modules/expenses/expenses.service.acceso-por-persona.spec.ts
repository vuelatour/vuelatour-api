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
import {
  CODIGO_CATEGORIA_SOLO_DIRECCION,
  MENSAJE_GASTOS_PERSONALES_SIN_ACCESO,
  MENSAJE_NOMINA_SIN_ACCESO,
} from '../../common/roles.util';

/**
 * ACCESO POR PERSONA en Gastos (12-nov-2026): el ALTA y la EDICIÓN de un
 * gasto de NÓMINA o de un GASTO PERSONAL, vedadas a Administración desde la
 * invariante 122, se le abren a quien Dirección le dio en Configuración el
 * acceso de ESA categoría — lista `acceso_nomina` (API 0.0.137, invariante
 * 132) o `acceso_gastos_personales` (API 0.0.138, invariante 133). Las dos
 * listas son independientes: el acceso a Nómina no abre los gastos
 * personales ni al revés. Cada lista se consulta SIN caché (una baja aplica
 * al instante) y solo para Administración + su categoría. Harness: el
 * builder que registra cada consulta, COPIADO de `expenses.service.afac.spec`.
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];
interface Consulta {
  tabla: string;
  ops: Op[];
}

const MARY = 'e0b26729-1f02-4dc0-9c1a-e7192e638478';
const ID = 'g-vigente';
const HOY = new Date('2026-11-12T18:00:00Z'); // jueves, 13:00 Cancún

/** Gasto vigente (lo que lee `findById`): por defecto, un pago de nómina. */
function gastoActual(extra: Fila = {}): Fila {
  return {
    id: ID,
    vuelo_id: null,
    aeronave_id: null,
    escala_id: null,
    usuario_captura_id: 'u-direccion',
    categoria: 'NOMINA',
    monto: '18500.00',
    propina: '0.00',
    moneda: 'MXN',
    medio_pago: 'TRANSFERENCIA',
    fecha_gasto: '2026-11-10',
    notas: 'Luis · 1a nov',
    valor_ia_extraido: null,
    tua_incluida: null,
    conciliado: false,
    created_at: '2026-11-10T15:00:00Z',
    updated_at: '2026-11-10T15:00:00Z',
    ...extra,
  };
}

function armar(
  opts: {
    /** Está en la lista `acceso_nomina`. */
    nomina?: boolean;
    /** Está en la lista `acceso_gastos_personales`. */
    personales?: boolean;
    actual?: Fila;
  } = {},
) {
  const consultas: Consulta[] = [];
  const resolver = (c: Consulta, single: boolean) => {
    const op = (m: string) => c.ops.find((o) => o[0] === m);
    if (c.tabla === 'gasto') {
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
    if (
      c.tabla === 'movimiento_bancario_gasto' ||
      c.tabla === 'movimiento_bancario'
    ) {
      return { data: [], error: null, count: 0 };
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
  /** `ConfiguracionService.tieneAccesoNomina` (la lista `acceso_nomina`). */
  const tieneAccesoNomina = jest.fn().mockResolvedValue(opts.nomina === true);
  /** `ConfiguracionService.tieneAccesoGastosPersonales` (la otra lista). */
  const tieneAccesoGastosPersonales = jest
    .fn()
    .mockResolvedValue(opts.personales === true);
  const configuracion = {
    numero: jest.fn().mockResolvedValue(1),
    tieneAccesoNomina,
    tieneAccesoGastosPersonales,
  };
  const nada = {} as never;
  const service = new ExpensesService(
    supabase,
    notifications,
    nada,
    nada,
    configuracion as never,
    nada,
    nada,
  );
  const cuerpoDe = (m: 'insert' | 'update'): Fila | undefined =>
    consultas
      .filter((c) => c.tabla === 'gasto')
      .flatMap((c) => c.ops)
      .find((o) => o[0] === m)?.[1][0] as Fila | undefined;
  return {
    service,
    consultas,
    tieneAccesoNomina,
    tieneAccesoGastosPersonales,
    cuerpoDe,
  };
}

function alta(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return {
    categoria: CategoriaGasto.NOMINA,
    monto: 18500,
    moneda: Moneda.MXN,
    fecha_gasto: '2026-11-12',
    medio_pago: MedioPago.TRANSFERENCIA,
    notas: 'Luis · 1a nov',
    ...extra,
  };
}

/** Alta de un gasto personal del dueño (sin vuelo ni avión, como exige el API). */
function altaPersonal(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return alta({
    categoria: CategoriaGasto.PERSONAL_DUENO,
    monto: 2350,
    notas: 'Súper de la casa',
    ...extra,
  });
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

describe('ExpensesService — acceso por persona a Nómina y a Gastos personales', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('tieneAccesoACategoria: cada categoría lee SU lista, sin caché, y nunca la otra', async () => {
    const a = armar({ nomina: true, personales: false });
    expect(await a.service.tieneAccesoACategoria(MARY, 'NOMINA')).toBe(true);
    expect(a.tieneAccesoNomina).toHaveBeenCalledWith(MARY, {
      usarCache: false,
    });
    expect(a.tieneAccesoGastosPersonales).not.toHaveBeenCalled();
    expect(await a.service.tieneAccesoACategoria(MARY, 'PERSONAL_DUENO')).toBe(
      false,
    );
    expect(a.tieneAccesoGastosPersonales).toHaveBeenCalledWith(MARY, {
      usarCache: false,
    });
    expect(a.tieneAccesoNomina).toHaveBeenCalledTimes(1);
    // Una categoría sin lista (un cast de más) no abre nada.
    expect(await a.service.tieneAccesoACategoria(MARY, 'GAS' as never)).toBe(
      false,
    );
  });

  describe('Nómina (invariante 132)', () => {
    describe('alta', () => {
      it('Administración SIN el acceso ⇒ 403 CATEGORIA_SOLO_DIRECCION (dice a quién pedírselo) y no inserta', async () => {
        const a = armar({ nomina: false });
        const r = await rebote(a.service.create(alta(), MARY, Rol.ADMIN));
        expect(r.status).toBe(403);
        expect(r.body.error).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect(r.body.message).toBe(MENSAJE_NOMINA_SIN_ACCESO);
        expect(a.cuerpoDe('insert')).toBeUndefined();
        // Por PERSONA y sin caché: la lista vigente, con quien captura.
        expect(a.tieneAccesoNomina).toHaveBeenCalledWith(MARY, {
          usarCache: false,
        });
      });

      it('Administración CON el acceso que da Dirección ⇒ el pago de nómina se registra', async () => {
        const a = armar({ nomina: true });
        await a.service.create(alta(), MARY, Rol.ADMIN, { notificar: false });
        expect(a.cuerpoDe('insert')).toMatchObject({
          categoria: 'NOMINA',
          monto: 18500,
          usuario_captura_id: MARY,
        });
        expect(a.tieneAccesoNomina).toHaveBeenCalledTimes(1);
        expect(a.tieneAccesoGastosPersonales).not.toHaveBeenCalled();
      });

      it('el acceso a Nómina NO abre los gastos personales: 403 que dice a quién pedirle ESE acceso, sin consultar la lista de Nómina', async () => {
        const a = armar({ nomina: true, personales: false });
        const r = await rebote(
          a.service.create(altaPersonal(), MARY, Rol.ADMIN),
        );
        expect(r.status).toBe(403);
        expect(r.body.error).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect(r.body.message).toBe(MENSAJE_GASTOS_PERSONALES_SIN_ACCESO);
        expect(a.cuerpoDe('insert')).toBeUndefined();
        expect(a.tieneAccesoNomina).not.toHaveBeenCalled();
        expect(a.tieneAccesoGastosPersonales).toHaveBeenCalledWith(MARY, {
          usarCache: false,
        });
      });

      it('la lista NO se consulta para quien entra por su rol ni para otras categorías', async () => {
        for (const rol of [Rol.DIRECCION, Rol.COORDINADOR, Rol.FACTURACION]) {
          const a = armar({ nomina: false });
          await a.service.create(alta(), 'u-oficina', rol, {
            notificar: false,
          });
          expect(a.cuerpoDe('insert')).toMatchObject({ categoria: 'NOMINA' });
          expect(a.tieneAccesoNomina).not.toHaveBeenCalled();
        }
        const b = armar({ nomina: false });
        await b.service.create(
          alta({ categoria: CategoriaGasto.OTRO }),
          MARY,
          Rol.ADMIN,
          { notificar: false },
        );
        expect(b.cuerpoDe('insert')).toMatchObject({ categoria: 'OTRO' });
        expect(b.tieneAccesoNomina).not.toHaveBeenCalled();
        expect(b.tieneAccesoGastosPersonales).not.toHaveBeenCalled();
      });
    });

    describe('edición', () => {
      const patch = (a: ReturnType<typeof armar>, dto: UpdateGastoDto) =>
        a.service.update(ID, dto, MARY, Rol.ADMIN);

      it('Administración SIN el acceso no edita un pago de nómina ni mueve un gasto a Nómina: 403 sin escribir', async () => {
        const a = armar({ nomina: false, actual: gastoActual() });
        const r1 = await rebote(patch(a, { monto: 19000 }));
        expect(r1.status).toBe(403);
        expect(r1.body.error).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect(r1.body.message).toBe(MENSAJE_NOMINA_SIN_ACCESO);
        expect(a.cuerpoDe('update')).toBeUndefined();

        const b = armar({
          nomina: false,
          actual: gastoActual({ categoria: 'OTRO' }),
        });
        const r2 = await rebote(patch(b, { categoria: CategoriaGasto.NOMINA }));
        expect(r2.status).toBe(403);
        expect(r2.body.error).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect(b.cuerpoDe('update')).toBeUndefined();
        expect(b.tieneAccesoNomina).toHaveBeenCalledWith(MARY, {
          usarCache: false,
        });
      });

      it('Administración CON el acceso edita el pago de nómina', async () => {
        const a = armar({ nomina: true, actual: gastoActual() });
        await patch(a, { monto: 19000 });
        expect(a.cuerpoDe('update')).toMatchObject({ monto: 19000 });
        expect(a.tieneAccesoNomina).toHaveBeenCalledWith(MARY, {
          usarCache: false,
        });
      });

      it('con el acceso a Nómina tampoco se mueve un gasto a «gastos personales»', async () => {
        const a = armar({
          nomina: true,
          personales: false,
          actual: gastoActual({ categoria: 'OTRO' }),
        });
        const r = await rebote(
          patch(a, { categoria: CategoriaGasto.PERSONAL_DUENO }),
        );
        expect(r.status).toBe(403);
        expect(r.body.message).toBe(MENSAJE_GASTOS_PERSONALES_SIN_ACCESO);
        expect(a.cuerpoDe('update')).toBeUndefined();
        expect(a.tieneAccesoNomina).not.toHaveBeenCalled();
      });
    });
  });

  describe('Gastos personales (invariante 133)', () => {
    describe('alta', () => {
      it('Administración SIN el acceso ⇒ 403 CATEGORIA_SOLO_DIRECCION (dice a quién pedírselo) y no inserta', async () => {
        const a = armar({ personales: false });
        const r = await rebote(
          a.service.create(altaPersonal(), MARY, Rol.ADMIN),
        );
        expect(r.status).toBe(403);
        expect(r.body.error).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect(r.body.message).toBe(MENSAJE_GASTOS_PERSONALES_SIN_ACCESO);
        expect(a.cuerpoDe('insert')).toBeUndefined();
        // Por PERSONA y sin caché: la lista vigente, con quien captura.
        expect(a.tieneAccesoGastosPersonales).toHaveBeenCalledWith(MARY, {
          usarCache: false,
        });
      });

      it('Administración CON el acceso que da Dirección ⇒ el gasto personal se registra', async () => {
        const a = armar({ personales: true });
        await a.service.create(altaPersonal(), MARY, Rol.ADMIN, {
          notificar: false,
        });
        expect(a.cuerpoDe('insert')).toMatchObject({
          categoria: 'PERSONAL_DUENO',
          monto: 2350,
          usuario_captura_id: MARY,
        });
        expect(a.tieneAccesoGastosPersonales).toHaveBeenCalledTimes(1);
        expect(a.tieneAccesoNomina).not.toHaveBeenCalled();
      });

      it('el acceso a Gastos personales NO abre la nómina: 403 que dice a quién pedirle ESE acceso, sin consultar la lista de gastos personales', async () => {
        const a = armar({ personales: true, nomina: false });
        const r = await rebote(a.service.create(alta(), MARY, Rol.ADMIN));
        expect(r.status).toBe(403);
        expect(r.body.error).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect(r.body.message).toBe(MENSAJE_NOMINA_SIN_ACCESO);
        expect(a.cuerpoDe('insert')).toBeUndefined();
        expect(a.tieneAccesoGastosPersonales).not.toHaveBeenCalled();
      });

      it('con el acceso sigue valiendo la regla del gasto personal: sin vuelo ni avión (400, no se inserta)', async () => {
        const a = armar({ personales: true });
        const r = await rebote(
          a.service.create(
            altaPersonal({
              aeronave_id: '5a82eb4a-086c-4058-97bd-b2aacdc2e942',
            }),
            MARY,
            Rol.ADMIN,
          ),
        );
        expect(r.status).toBe(400);
        expect(a.cuerpoDe('insert')).toBeUndefined();
      });

      it('la lista NO se consulta para quien entra por su rol', async () => {
        for (const rol of [Rol.DIRECCION, Rol.COORDINADOR]) {
          const a = armar({ personales: false });
          await a.service.create(altaPersonal(), 'u-oficina', rol, {
            notificar: false,
          });
          expect(a.cuerpoDe('insert')).toMatchObject({
            categoria: 'PERSONAL_DUENO',
          });
          expect(a.tieneAccesoGastosPersonales).not.toHaveBeenCalled();
          expect(a.tieneAccesoNomina).not.toHaveBeenCalled();
        }
      });
    });

    describe('edición', () => {
      const personal = (extra: Fila = {}) =>
        gastoActual({
          categoria: 'PERSONAL_DUENO',
          monto: '2350.00',
          notas: 'Súper de la casa',
          ...extra,
        });
      const patch = (a: ReturnType<typeof armar>, dto: UpdateGastoDto) =>
        a.service.update(ID, dto, MARY, Rol.ADMIN);

      it('Administración SIN el acceso no edita un gasto personal ni mueve un gasto a «gastos personales»: 403 sin escribir', async () => {
        const a = armar({ personales: false, actual: personal() });
        const r1 = await rebote(patch(a, { monto: 2400 }));
        expect(r1.status).toBe(403);
        expect(r1.body.error).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect(r1.body.message).toBe(MENSAJE_GASTOS_PERSONALES_SIN_ACCESO);
        expect(a.cuerpoDe('update')).toBeUndefined();

        const b = armar({
          personales: false,
          actual: gastoActual({ categoria: 'OTRO' }),
        });
        const r2 = await rebote(
          patch(b, { categoria: CategoriaGasto.PERSONAL_DUENO }),
        );
        expect(r2.status).toBe(403);
        expect(r2.body.error).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect(b.cuerpoDe('update')).toBeUndefined();
        expect(b.tieneAccesoGastosPersonales).toHaveBeenCalledWith(MARY, {
          usarCache: false,
        });
      });

      it('Administración CON el acceso edita el gasto personal', async () => {
        const a = armar({ personales: true, actual: personal() });
        await patch(a, { monto: 2400 });
        expect(a.cuerpoDe('update')).toMatchObject({ monto: 2400 });
        expect(a.tieneAccesoGastosPersonales).toHaveBeenCalledWith(MARY, {
          usarCache: false,
        });
        expect(a.tieneAccesoNomina).not.toHaveBeenCalled();
      });

      it('con el acceso a Gastos personales tampoco se mueve un gasto a Nómina', async () => {
        const a = armar({
          personales: true,
          nomina: false,
          actual: gastoActual({ categoria: 'OTRO' }),
        });
        const r = await rebote(patch(a, { categoria: CategoriaGasto.NOMINA }));
        expect(r.status).toBe(403);
        expect(r.body.message).toBe(MENSAJE_NOMINA_SIN_ACCESO);
        expect(a.cuerpoDe('update')).toBeUndefined();
        expect(a.tieneAccesoGastosPersonales).not.toHaveBeenCalled();
      });
    });
  });
});
