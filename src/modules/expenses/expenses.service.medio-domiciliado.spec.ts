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
import { MENSAJE_MEDIO_SOLO_OFICINA } from '../../common/medio-pago.util';

/**
 * «PAGO DOMICILIADO» (13-oct-2026, invariante 64): cargo automático a la
 * cuenta (suscripciones, seguros, servicios). Medio BANCARIO que solo
 * registra la OFICINA: un rol de campo recibe 400 `MEDIO_SOLO_OFICINA` en el
 * alta ANTES de tocar la BD; la oficina lo guarda sin tarjeta y dispara el
 * auto-cruce con el banco como a cualquier bancario; `list()` le anexa lo ya
 * ligado (pagos parciales).
 */
type Fila = Record<string, unknown>;
type Llamada = { tabla: string; metodo: string; args: unknown[] };

const VUELO = '11111111-1111-4111-8111-111111111111';
const AVION = '33333333-3333-4333-8333-333333333333';
const HOY = new Date('2026-10-13T18:00:00Z'); // martes, 13:00 Cancún

function armar(
  opts: {
    vinculado?: Array<{ gasto_id: string; monto_vinculado: number }>;
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
              data: { id: 'g-dom', conciliado: false, ...cuerpo },
              error: null,
            });
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
    medio_pago: MedioPago.DOMICILIADO,
    aeronave_id: AVION,
    notas: 'DLO*STARLINK Carg Recur.',
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

describe('ExpensesService — «Pago domiciliado» (13-oct-2026, invariante 64)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('PILOTO, MECÁNICO y VISITANTE ⇒ 400 MEDIO_SOLO_OFICINA con el texto exacto, SIN tocar la BD', async () => {
    const casos: Array<[Rol, Partial<CreateGastoDto>]> = [
      [Rol.PILOTO, { vuelo_id: VUELO, categoria: CategoriaGasto.COMIDA }],
      // El mecánico solo carga GAS: su regla de categoría pasa y rebota
      // por el medio.
      [Rol.MECANICO, { categoria: CategoriaGasto.GAS }],
      // El visitante: el mismo 400 (va ANTES de su regla de medio).
      [Rol.VISITANTE, {}],
    ];
    for (const [rol, extra] of casos) {
      const { service, llamadas, intentarCruzarGasto } = armar();
      const r = await rebote(service.create(dto(extra), 'u-campo', rol));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('MEDIO_SOLO_OFICINA');
      expect(r.body.message).toBe(MENSAJE_MEDIO_SOLO_OFICINA);
      expect(r.body.message).toBe(
        'El pago domiciliado lo registra la oficina: elige otro medio de pago.',
      );
      expect(llamadas).toHaveLength(0);
      expect(intentarCruzarGasto).not.toHaveBeenCalled();
    }
  });

  it('control: el mismo PILOTO con TRANSFERENCIA no rebota por el medio', async () => {
    const { service, insertado } = armar();
    await service.create(
      dto({
        vuelo_id: VUELO,
        categoria: CategoriaGasto.COMIDA,
        medio_pago: MedioPago.TRANSFERENCIA,
      }),
      'u-piloto',
      Rol.PILOTO,
      { notificar: false },
    );
    expect(insertado()).toMatchObject({ medio_pago: 'TRANSFERENCIA' });
  });

  it('ADMIN y COORDINADOR lo guardan SIN tarjeta y disparan el auto-cruce con el banco (es bancario)', async () => {
    for (const rol of [Rol.ADMIN, Rol.COORDINADOR]) {
      const { service, insertado, intentarCruzarGasto } = armar();
      await service.create(
        // Aunque alguien mande una terminación, fuera de TARJETA_CORP no
        // se guarda (CHECK `gasto_check`).
        dto({ tarjeta_terminacion: '4321' }),
        'u-oficina',
        rol,
        { notificar: false },
      );
      expect(insertado()).toMatchObject({
        medio_pago: 'DOMICILIADO',
        tarjeta_terminacion: null,
      });
      expect(intentarCruzarGasto).toHaveBeenCalledWith('g-dom', 'u-oficina');
    }
  });

  it('list(): a un DOMICILIADO sin cubrir le anexa monto_vinculado / faltante / parcial (como a cualquier bancario)', async () => {
    const { service } = armar({
      vinculado: [{ gasto_id: 'g-dom', monto_vinculado: 400 }],
    });
    const filas: Fila[] = [
      {
        id: 'g-dom',
        medio_pago: 'DOMICILIADO',
        monto: 1000,
        conciliado: false,
      },
      { id: 'g-efe', medio_pago: 'EFECTIVO', monto: 50, conciliado: false },
    ];
    await (
      service as unknown as {
        anexarConciliacionParcial: (rows: Fila[]) => Promise<void>;
      }
    ).anexarConciliacionParcial(filas);
    expect(filas[0]).toMatchObject({
      monto_vinculado: 400,
      faltante: 600,
      parcial: true,
    });
    // Un medio no bancario no lleva los aditivos.
    expect(filas[1]).not.toHaveProperty('monto_vinculado');
  });
});
