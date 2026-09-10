// Módulos pesados que expenses.service importa solo para inyección (mismo
// patrón que expenses.service.spec): notifications arrastra el gateway y
// `jose` (ESM puro, jest no lo transforma).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import type { UpdateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { CajaChicaService } from '../caja-chica/caja-chica.service';
import { Rol } from '../../common/types/auth.types';

/**
 * Lote 2 Ola B (10-sep-2026) en gastos:
 *  - B1: `if_updated_at` → CAS en el UPDATE (ventana ±1 ms) y 409
 *    CONFLICTO_VERSION con la fila viva si 0 filas; sin el campo, igual que
 *    siempre. El PATCH conserva client_request_id y nunca reescribe
 *    capturado_en.
 *  - B3: ventana semanal contra el sello `capturado_en` de la corrección /
 *    baja (no contra la llegada al servidor) + línea de bitácora.
 *  - B4: codes en los 409 de remove / assertOwnEnVentana.
 * Supabase se simula con un builder encadenable que registra llamadas y
 * entrega resultados por tabla EN ORDEN de await.
 */
type Resultado = {
  data: unknown;
  error: null | { code?: string; message: string; details?: string };
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
      'delete',
    ]) {
      q[m] = registra(m);
    }
    q.maybeSingle = () => Promise.resolve(siguiente(tabla));
    q.then = (
      resolve: (v: Resultado) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(siguiente(tabla)).then(resolve, reject);
    return q;
  };
  return { llamadas, service: { from } };
}

function armar(tablas: Record<string, Resultado[]>, gracia = 1) {
  const sb = armarSupabase(tablas);
  const supabase = { service: sb.service } as unknown as SupabaseService;
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const configuracion = {
    numero: jest.fn().mockResolvedValue(gracia),
  } as unknown as ConfiguracionService;
  const cajaChica = {
    fechaUltimaReposicionDe: jest.fn().mockResolvedValue(null),
  } as unknown as CajaChicaService;
  const nada = {} as never;
  const service = new ExpensesService(
    supabase,
    notifications,
    nada,
    nada,
    configuracion,
    cajaChica,
    nada,
  );
  return { service, llamadas: sb.llamadas, cajaChica };
}

const de = (llamadas: Llamada[], tabla: string, metodo: string) =>
  llamadas.filter((l) => l.tabla === tabla && l.metodo === metodo);

const GASTO = {
  id: 'g-1',
  usuario_captura_id: 'u-piloto',
  categoria: 'TAXI',
  monto: 200,
  moneda: 'MXN',
  medio_pago: 'TRANSFERENCIA',
  fecha_gasto: '2026-09-09',
  conciliado: false,
  compra_id: null,
  notas: 'Taxi al hotel',
  client_request_id: 'k-alta',
  capturado_en: '2026-09-09T20:00:00.000Z',
  created_at: '2026-09-09T20:05:00.000Z',
  updated_at: '2026-09-10T15:00:00.123456+00:00',
};

describe('ExpensesService.update — B1 control de versión if_updated_at', () => {
  it('con if_updated_at el UPDATE lleva la ventana ±1 ms sobre updated_at y devuelve la fila', async () => {
    const { service, llamadas } = armar({
      gasto: [{ data: { ...GASTO, notas: 'x' }, error: null }],
    });
    const res = await service.update(
      'g-1',
      { notas: 'x', if_updated_at: '2026-09-10T15:00:00.123Z' },
      'u-admin',
      Rol.ADMIN,
    );
    expect(res).toMatchObject({ id: 'g-1', notas: 'x' });
    expect(de(llamadas, 'gasto', 'gte')).toEqual([
      {
        tabla: 'gasto',
        metodo: 'gte',
        args: ['updated_at', '2026-09-10T15:00:00.122Z'],
      },
    ]);
    expect(de(llamadas, 'gasto', 'lte')).toEqual([
      {
        tabla: 'gasto',
        metodo: 'lte',
        args: ['updated_at', '2026-09-10T15:00:00.124Z'],
      },
    ]);
    // if_updated_at NO es columna: jamás viaja en el payload del UPDATE.
    const payload = de(llamadas, 'gasto', 'update')[0].args[0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('if_updated_at');
    expect(payload).toMatchObject({ notas: 'x', updated_by: 'u-admin' });
  });

  it('0 filas con if_updated_at → relee y lanza 409 CONFLICTO_VERSION con la fila viva (gana el servidor)', async () => {
    const vivo = { ...GASTO, updated_at: '2026-09-10T16:00:00+00:00' };
    const { service } = armar({
      gasto: [
        { data: null, error: null }, // UPDATE con CAS: 0 filas
        { data: vivo, error: null }, // relectura
      ],
    });
    let err: unknown;
    try {
      await service.update(
        'g-1',
        { notas: 'x', if_updated_at: '2026-09-10T15:00:00.123Z' },
        'u-admin',
        Rol.ADMIN,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Record<
      string,
      unknown
    >;
    expect(body.error).toBe('CONFLICTO_VERSION');
    expect(body.message).toMatch(/modificó este gasto/);
    expect(body.details).toEqual({
      actual: vivo,
      updated_at_enviado: '2026-09-10T15:00:00.123Z',
      updated_at_actual: '2026-09-10T16:00:00+00:00',
    });
  });

  it('0 filas con if_updated_at y el gasto ya no existe → 404 (no 409)', async () => {
    const { service } = armar({
      gasto: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    await expect(
      service.update(
        'g-1',
        { notas: 'x', if_updated_at: '2026-09-10T15:00:00.123Z' },
        'u-admin',
        Rol.ADMIN,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sin if_updated_at: sin ventana (último gana) y 0 filas = 404 como siempre', async () => {
    const { service, llamadas } = armar({
      gasto: [{ data: null, error: null }],
    });
    await expect(
      service.update('g-1', { notas: 'x' }, 'u-admin', Rol.ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(de(llamadas, 'gasto', 'gte')).toHaveLength(0);
    expect(de(llamadas, 'gasto', 'lte')).toHaveLength(0);
  });

  it('el PATCH conserva client_request_id (no viaja en el UPDATE) y no reescribe capturado_en', async () => {
    const { service, llamadas } = armar({
      gasto: [{ data: { ...GASTO, notas: 'y' }, error: null }],
    });
    const dto = {
      notas: 'y',
      client_request_id: '11111111-1111-4111-8111-111111111111',
    } as UpdateGastoDto;
    const res = await service.update('g-1', dto, 'u-admin', Rol.ADMIN);
    const payload = de(llamadas, 'gasto', 'update')[0].args[0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('client_request_id');
    expect(payload).not.toHaveProperty('capturado_en');
    // La respuesta trae la llave de la captura ORIGINAL y su updated_at.
    expect(res).toMatchObject({
      client_request_id: 'k-alta',
      updated_at: GASTO.updated_at,
    });
  });
});

describe('ExpensesService — B3 ventana semanal contra capturado_en', () => {
  // Martes 15-sep-2026 16:00 Cancún (21:00Z). Gasto capturado el miércoles
  // 9-sep → su semana cierra el domingo 13 + 1 día de gracia = lunes 14.
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-15T21:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('sin sello: hoy (martes) ya pasó el lunes de gracia → 403 GASTO_FUERA_DE_VENTANA', async () => {
    const { service } = armar({ gasto: [{ data: GASTO, error: null }] });
    let err: unknown;
    try {
      await service.assertOwnEnVentana('g-1', 'u-piloto');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenException);
    const body = (err as ForbiddenException).getResponse() as Record<
      string,
      string
    >;
    expect(body.error).toBe('GASTO_FUERA_DE_VENTANA');
    expect(body.message).toMatch(/hasta el lunes siguiente/);
  });

  it('con sello del domingo (corrección hecha sin señal, subida el martes) → pasa', async () => {
    const { service } = armar({ gasto: [{ data: GASTO, error: null }] });
    await expect(
      service.assertOwnEnVentana(
        'g-1',
        'u-piloto',
        '2026-09-13T22:30:00-05:00',
      ),
    ).resolves.toBeUndefined();
  });

  it('el sello nunca cuenta a futuro: > 10 min → 400 antes de tocar nada; ≤ 10 min se acota a ahora', async () => {
    const { service, llamadas } = armar({
      gasto: [{ data: GASTO, error: null }],
    });
    await expect(
      service.assertOwnEnVentana('g-1', 'u-piloto', '2026-09-15T21:30:00Z'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(de(llamadas, 'gasto', 'select')).toHaveLength(0);
    // Reloj adelantado 5 min: se evalúa como hoy (martes) → fuera de ventana.
    await expect(
      service.assertOwnEnVentana('g-1', 'u-piloto', '2026-09-15T21:05:00Z'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sello sin zona → 400 (misma regla estricta que el alta)', async () => {
    const { service } = armar({ gasto: [{ data: GASTO, error: null }] });
    await expect(
      service.assertOwnEnVentana('g-1', 'u-piloto', '2026-09-13T22:30:00'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('codes de los candados previos: GASTO_AJENO, GASTO_CONCILIADO, GASTO_EN_REPOSICION', async () => {
    const code = async (
      gasto: Record<string, unknown>,
      userId: string,
      ultima: string | null = null,
    ) => {
      const { service, cajaChica } = armar({
        gasto: [{ data: gasto, error: null }],
      });
      (cajaChica.fechaUltimaReposicionDe as jest.Mock).mockResolvedValue(
        ultima,
      );
      try {
        await service.assertOwnEnVentana('g-1', userId);
      } catch (e) {
        return (e as { getResponse(): { error?: string } }).getResponse().error;
      }
      return null;
    };
    expect(await code(GASTO, 'u-otro')).toBe('GASTO_AJENO');
    expect(await code({ ...GASTO, conciliado: true }, 'u-piloto')).toBe(
      'GASTO_CONCILIADO',
    );
    expect(
      await code(
        { ...GASTO, medio_pago: 'EFECTIVO', fecha_gasto: '2026-09-09' },
        'u-piloto',
        '2026-09-10',
      ),
    ).toBe('GASTO_EN_REPOSICION');
  });

  it('PATCH con sello tardío: anexa «[Corrección capturada en la app el … · recibida el …]» a las notas vigentes', async () => {
    const { service, llamadas } = armar({
      gasto: [
        { data: GASTO, error: null }, // actual (notas vigentes)
        { data: { ...GASTO, lugar: 'CUN' }, error: null }, // UPDATE
      ],
    });
    await service.update(
      'g-1',
      { lugar: 'CUN', capturado_en: '2026-09-13T22:30:00-05:00' },
      'u-piloto',
      Rol.PILOTO,
    );
    const payload = de(llamadas, 'gasto', 'update')[0].args[0] as Record<
      string,
      unknown
    >;
    expect(payload.notas).toBe(
      'Taxi al hotel\n[Corrección capturada en la app el 13 sep 22:30 · recibida el 15 sep 16:00]',
    );
    expect(payload).not.toHaveProperty('capturado_en');
    // Edición de campo por rol de campo: limpia el sello de verificación.
    expect(payload).toMatchObject({
      verificado_por: null,
      verificado_at: null,
    });
  });

  it('PATCH con sello reciente (en línea): sin línea de bitácora y sin cambios extra', async () => {
    const { service, llamadas } = armar({
      gasto: [{ data: { ...GASTO, lugar: 'CUN' }, error: null }],
    });
    await service.update(
      'g-1',
      { lugar: 'CUN', capturado_en: '2026-09-15T20:59:30Z' },
      'u-admin',
      Rol.ADMIN,
    );
    const payload = de(llamadas, 'gasto', 'update')[0].args[0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('notas');
  });

  it('DELETE con sello tardío: la línea «Baja capturada…» va en el sello previo al borrado', async () => {
    const { service, llamadas } = armar({
      gasto: [
        { data: GASTO, error: null }, // findById
        { data: null, error: null }, // update de sello
        { data: null, error: null }, // delete
      ],
      gasto_reparto: [{ data: [], error: null }],
    });
    const res = await service.remove(
      'g-1',
      'u-piloto',
      Rol.PILOTO,
      '2026-09-13T22:30:00-05:00',
    );
    expect(res).toMatchObject({ deleted: true, id: 'g-1' });
    const sello = de(llamadas, 'gasto', 'update')[0].args[0] as Record<
      string,
      unknown
    >;
    expect(sello).toEqual({
      updated_by: 'u-piloto',
      notas:
        'Taxi al hotel\n[Baja capturada en la app el 13 sep 22:30 · recibida el 15 sep 16:00]',
    });
    expect(de(llamadas, 'gasto', 'delete')).toHaveLength(1);
  });

  it('DELETE sin sello: el update previo solo sella updated_by (diff vacío para la bitácora)', async () => {
    const { service, llamadas } = armar({
      gasto: [{ data: GASTO, error: null }],
      gasto_reparto: [{ data: [], error: null }],
    });
    await service.remove('g-1', 'u-admin', Rol.ADMIN);
    expect(de(llamadas, 'gasto', 'update')[0].args[0]).toEqual({
      updated_by: 'u-admin',
    });
  });
});

describe('ExpensesService.remove — B4 codes en los 409', () => {
  const code = async (
    gasto: Record<string, unknown>,
    rol: Rol,
    repartos: unknown[] = [],
  ) => {
    const { service } = armar({
      gasto: [{ data: gasto, error: null }],
      compra: [{ data: { folio: 12 }, error: null }],
      gasto_reparto: [{ data: repartos, error: null }],
    });
    try {
      await service.remove('g-1', 'u-1', rol);
    } catch (e) {
      const r = (e as ConflictException).getResponse() as Record<
        string,
        unknown
      >;
      return { code: r.error, message: r.message, details: r.details };
    }
    return null;
  };

  it('conciliado → GASTO_CONCILIADO (message intacto)', async () => {
    expect(await code({ ...GASTO, conciliado: true }, Rol.ADMIN)).toEqual({
      code: 'GASTO_CONCILIADO',
      message:
        'Este gasto ya está conciliado con el banco; desconcíliaselo en Conciliación antes de eliminarlo.',
      details: undefined,
    });
  });

  it('pago de compra → GASTO_DE_COMPRA con compra_id/folio', async () => {
    expect(await code({ ...GASTO, compra_id: 'c-1' }, Rol.ADMIN)).toEqual({
      code: 'GASTO_DE_COMPRA',
      message:
        'Este gasto es un pago de la compra #12 de refacciones; quítalo primero desde Compras.',
      details: { compra_id: 'c-1', folio: 12 },
    });
  });

  it('repartido y rol de campo → GASTO_REPARTIDO; la oficina sí puede borrarlo', async () => {
    const repartos = [{ gasto_id: 'g-1', aeronave_id: 'a-1', monto: 100 }];
    expect(await code(GASTO, Rol.PILOTO, repartos)).toMatchObject({
      code: 'GASTO_REPARTIDO',
      details: { repartos: 1 },
    });
    expect(await code(GASTO, Rol.ADMIN, repartos)).toBeNull();
  });
});
