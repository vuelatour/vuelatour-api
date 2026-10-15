// Mismos stubs que expenses.service.sin-vuelo.spec.ts.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { ConflictException, HttpException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto } from './dto/expenses.dto';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';
import { errorCargosAGastoNoDisponible } from '../../common/omision-cargos-disponible.util';
import { sembrarPartes } from '../conciliacion/conciliacion-partes.fixture-spec';
import {
  escrituras,
  fakePostgrest,
  type OpcionesFake,
  type Row,
  type Tablas,
} from '../conciliacion/conciliacion-postgrest.fixture-spec';

/**
 * «VARIOS CARGOS → UN GASTO», «Créalo por la suma» (14-oct-2026, API
 * 0.0.77, invariante 76): `POST /v1/expenses` con `conciliar_con_movimientos`.
 * Lo que se custodia: el gasto nace YA ligado o NO queda nada (compensación
 * con `remove`); sin auto-cruce; los avisos salen SOLO tras la liga; la llave
 * de la captura hace el reintento idempotente; sin el campo, el alta de
 * siempre (los avisos y el auto-cruce en su orden).
 */
const USER = 'cccccccc-0000-4000-8000-000000000001';
const LLAVE = '11111111-2222-4333-8444-555555555555';
const C1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const C2 = 'bbbbbbbb-0000-4000-8000-000000000002';

function dto(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return {
    categoria: CategoriaGasto.OPERACIONES,
    monto: 9700,
    moneda: Moneda.MXN,
    fecha_gasto: '2026-09-24',
    medio_pago: MedioPago.TRANSFERENCIA,
    notas: 'VIP SAESA · fact 7360',
    client_request_id: LLAVE,
    conciliar_con_movimientos: [C1, C2.toUpperCase()],
    ...extra,
  };
}

const liga = (gastoId: string, ids: string[]) => ({
  gasto_id: gastoId,
  idempotente: false,
  nuevos: ids,
  partes: ids.map((m, i) => ({
    movimiento_id: m,
    monto_parte: i === 0 ? 3000 : 6700,
    moneda: 'MXN',
  })),
  gasto_estado: {
    monto: 9700,
    moneda: 'MXN',
    n_partes: 2,
    monto_vinculado: 9700,
    faltante: 0,
    cubierto: true,
  },
  movimientos: [],
});

function armar(
  opts: {
    db?: Partial<Tablas>;
    fake?: OpcionesFake;
    disponible?: boolean;
    sinConciliacion?: boolean;
    ligar?: jest.Mock;
    prevalidar?: jest.Mock;
  } = {},
) {
  const db: Tablas = {
    gasto: [],
    gasto_reparto: [],
    movimiento_bancario: [],
    movimiento_bancario_gasto: [],
    ...opts.db,
  };
  sembrarPartes(db);
  const fake = fakePostgrest(db, opts.fake);
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  };
  const conciliacion = {
    cargosAGastoDisponible: jest
      .fn()
      .mockResolvedValue(opts.disponible ?? true),
    prevalidarCargosParaGastoNuevo:
      opts.prevalidar ??
      jest.fn().mockResolvedValue({ moneda: 'MXN', suma: 9700 }),
    ligarCargosAGasto:
      opts.ligar ??
      jest.fn().mockImplementation((gastoId: string, ids: string[]) => {
        // La BD (`recalcular_gasto_conciliado`) marca el gasto cubierto.
        const g = db.gasto.find((x) => x.id === gastoId);
        if (g) g.conciliado = true;
        return Promise.resolve(liga(gastoId, ids));
      }),
    intentarCruzarGasto: jest.fn().mockResolvedValue(null),
  };
  const nada = {} as never;
  const svc = new ExpensesService(
    fake.supabase,
    notifications as unknown as NotificationsService,
    nada,
    nada,
    { numero: jest.fn().mockResolvedValue(1) } as never,
    nada,
    nada,
    opts.sinConciliacion ? undefined : (conciliacion as never),
  );
  return { svc, db, notifications, conciliacion, ...fake };
}

async function rechazo(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus?.(),
      body: err.getResponse?.() as {
        message: string;
        error: string;
        details?: Row;
      },
    };
  }
  throw new Error('se esperaba un rechazo');
}

const insertsDeGasto = (log: ReturnType<typeof armar>['log']) =>
  log.filter((o) => o.tabla === 'gasto' && o.op === 'insert');

describe('alta de SIEMPRE (sin `conciliar_con_movimientos`): byte a byte', () => {
  it('auto-cruce y aviso «gasto_registrado» de inmediato; sin bloque `conciliacion`', async () => {
    const w = armar();
    const { conciliar_con_movimientos: _fuera, ...base } = dto();
    void _fuera;
    const r = (await w.svc.create(base, USER, Rol.ADMIN)) as Row;
    expect(r).not.toHaveProperty('conciliacion');
    expect(w.conciliacion.intentarCruzarGasto).toHaveBeenCalledWith(r.id, USER);
    expect(w.notifications.notifyRole).toHaveBeenCalledWith(
      Rol.ADMIN,
      expect.objectContaining({ tipo: 'gasto_registrado' }),
      USER,
    );
    expect(w.conciliacion.ligarCargosAGasto).not.toHaveBeenCalled();
    expect(
      w.conciliacion.prevalidarCargosParaGastoNuevo,
    ).not.toHaveBeenCalled();
  });

  it('`null` cuenta como ausente', async () => {
    const w = armar();
    await w.svc.create(
      dto({ conciliar_con_movimientos: null as never }),
      USER,
      Rol.ADMIN,
    );
    expect(w.conciliacion.ligarCargosAGasto).not.toHaveBeenCalled();
    expect(w.conciliacion.intentarCruzarGasto).toHaveBeenCalled();
  });
});

describe('alta por la suma — el camino feliz', () => {
  it('crea SIN auto-cruce, liga en la MISMA petición y avisa DESPUÉS de la liga', async () => {
    const w = armar();
    const r = (await w.svc.create(dto(), USER, Rol.FACTURACION)) as Row & {
      conciliacion: Row;
    };
    expect(w.db.gasto).toHaveLength(1);
    const gastoId = w.db.gasto[0].id as string;
    expect(w.conciliacion.prevalidarCargosParaGastoNuevo).toHaveBeenCalledWith(
      [C1, C2],
      {
        moneda: 'MXN',
        monto: 9700,
        medio_pago: 'TRANSFERENCIA',
        fecha_gasto: '2026-09-24',
      },
    );
    expect(w.conciliacion.ligarCargosAGasto).toHaveBeenCalledWith(
      gastoId,
      [C1, C2],
      USER,
      {
        accion: 'crear',
      },
    );
    expect(w.conciliacion.intentarCruzarGasto).not.toHaveBeenCalled();
    // El aviso «gasto_registrado» salió DESPUÉS de la liga.
    const ordenLiga =
      w.conciliacion.ligarCargosAGasto.mock.invocationCallOrder[0];
    const ordenAviso = w.notifications.notifyRole.mock.invocationCallOrder[0];
    expect(ordenAviso).toBeGreaterThan(ordenLiga);
    // La respuesta es el gasto RELEÍDO (conciliado por la BD) + el bloque.
    expect(r.id).toBe(gastoId);
    expect(r.conciliado).toBe(true);
    expect(r.conciliacion).toEqual({
      movimiento_ids: [C1, C2],
      idempotente: false,
      partes: [
        { movimiento_id: C1, monto_parte: 3000, moneda: 'MXN' },
        { movimiento_id: C2, monto_parte: 6700, moneda: 'MXN' },
      ],
      gasto_estado: {
        monto: 9700,
        moneda: 'MXN',
        n_partes: 2,
        monto_vinculado: 9700,
        faltante: 0,
        cubierto: true,
      },
    });
    // El campo NO es columna: el insert no lo lleva.
    const cuerpo = insertsDeGasto(w.log)[0].cuerpo as Row;
    expect(cuerpo).not.toHaveProperty('conciliar_con_movimientos');
    expect(cuerpo.client_request_id).toBe(LLAVE);
  });
});

describe('alta por la suma — rechazos SIN crear', () => {
  it('refacción a Inventario/Tienda ⇒ 400 INVENTARIO_NO_DESDE_CARGOS', async () => {
    const w = armar();
    const r = await rechazo(
      w.svc.create(
        dto({
          inventario: {
            nombre: 'Filtro',
            cantidad: 1,
            precio_venta: 10,
            precio_venta_moneda: 'MXN',
          } as never,
        }),
        USER,
        Rol.ADMIN,
      ),
    );
    expect([r.status, r.body.error, r.body.message]).toEqual([
      400,
      'INVENTARIO_NO_DESDE_CARGOS',
      'Una refacción que entra a Inventario/Tienda no se registra desde varios cargos: regístrala en Gastos y vincula los cargos después.',
    ]);
    expect(insertsDeGasto(w.log)).toHaveLength(0);
  });

  it('sin `client_request_id` ⇒ 400 CLIENT_REQUEST_ID_REQUERIDO', async () => {
    const w = armar();
    const r = await rechazo(
      w.svc.create(dto({ client_request_id: undefined }), USER, Rol.ADMIN),
    );
    expect([r.status, r.body.error, r.body.message]).toEqual([
      400,
      'CLIENT_REQUEST_ID_REQUERIDO',
      'Falta la llave de la captura: recarga la página y vuelve a intentarlo.',
    ]);
    expect(escrituras(w.log)).toHaveLength(0);
  });

  it('sin la migración (o sin el módulo de conciliación) ⇒ 503 y nada escrito', async () => {
    for (const w of [
      armar({ disponible: false }),
      armar({ sinConciliacion: true }),
    ]) {
      const r = await rechazo(w.svc.create(dto(), USER, Rol.ADMIN));
      expect([r.status, r.body.error]).toEqual([
        503,
        'CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE',
      ]);
      expect(escrituras(w.log)).toHaveLength(0);
    }
  });

  it('la prevalidación rechaza ⇒ su 4xx tal cual y NO se crea el gasto', async () => {
    const w = armar({
      prevalidar: jest.fn().mockRejectedValue(
        new ConflictException({
          message:
            'No se registró el gasto: los cargos son de cuentas en MXN y USD: un gasto se paga en una sola moneda.',
          error: 'CARGOS_MONEDA_DISTINTA',
        }),
      ),
    });
    const r = await rechazo(w.svc.create(dto(), USER, Rol.ADMIN));
    expect([r.status, r.body.error]).toEqual([409, 'CARGOS_MONEDA_DISTINTA']);
    expect(insertsDeGasto(w.log)).toHaveLength(0);
    expect(w.conciliacion.ligarCargosAGasto).not.toHaveBeenCalled();
  });
});

describe('alta por la suma — la liga falla: se RETIRA el gasto', () => {
  it('un 409 de la liga sale con «No se registró el gasto: » y `compensado`; sin avisos ni auto-cruce', async () => {
    const w = armar({
      ligar: jest.fn().mockRejectedValue(
        new ConflictException({
          message:
            'Los 2 cargos suman $9,700.00 y al gasto le faltan $9,591.49 (vale $9,591.49): se pasarían por $108.51 (tolerancia $1.00). Revisa la selección o el monto del gasto.',
          error: 'CARGOS_EXCEDEN_GASTO',
          details: { excedente: 108.51 },
        }),
      ),
    });
    const r = await rechazo(w.svc.create(dto(), USER, Rol.ADMIN));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      message:
        'No se registró el gasto: los 2 cargos suman $9,700.00 y al gasto le faltan $9,591.49 (vale $9,591.49): se pasarían por $108.51 (tolerancia $1.00). Revisa la selección o el monto del gasto.',
      error: 'CARGOS_EXCEDEN_GASTO',
      details: { excedente: 108.51, compensado: true },
    });
    expect(w.db.gasto).toHaveLength(0);
    expect(w.notifications.notifyRole).not.toHaveBeenCalled();
    expect(w.conciliacion.intentarCruzarGasto).not.toHaveBeenCalled();
  });

  it('un error que no es HTTP ⇒ 500 GASTO_NO_REGISTRADO (el gasto ya se retiró)', async () => {
    const w = armar({
      ligar: jest.fn().mockRejectedValue(new Error('fetch failed')),
    });
    const r = await rechazo(w.svc.create(dto(), USER, Rol.ADMIN));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({
      message:
        'No se registró el gasto: la liga con los cargos del banco falló y el gasto se retiró. Vuelve a intentarlo; si se repite, avisa a sistemas.',
      error: 'GASTO_NO_REGISTRADO',
      details: { compensado: true, tecnico: 'fetch failed' },
    });
    expect(w.db.gasto).toHaveLength(0);
  });

  it('si el retiro también falla ⇒ 500 GASTO_SIN_VINCULAR con el gasto', async () => {
    const w = armar({
      ligar: jest.fn().mockRejectedValue(new Error('fetch failed')),
      fake: { fallos: { 'gasto:delete': { message: 'permission denied' } } },
    });
    const r = await rechazo(w.svc.create(dto(), USER, Rol.ADMIN));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({
      message:
        'El gasto se registró pero NO quedó vinculado a los cargos: vuelve a pulsar «Guardar» para reintentar la liga (no se duplica) o cancela y vincúlalo con «Vincular a un gasto».',
      error: 'GASTO_SIN_VINCULAR',
      details: { gasto_id: w.db.gasto[0].id },
    });
    expect(w.db.gasto).toHaveLength(1);
  });
});

describe('alta por la suma — REPLAY de la llave', () => {
  const previo = (extra: Row = {}): Row => ({
    id: 'g-previo',
    categoria: 'OPERACIONES',
    monto: 9700,
    moneda: 'MXN',
    medio_pago: 'TRANSFERENCIA',
    fecha_gasto: '2026-09-24',
    conciliado: false,
    client_request_id: LLAVE,
    ...extra,
  });

  it('mismos datos ⇒ la liga (idempotente) sin crear otro; `idempotente: true`', async () => {
    const w = armar({ db: { gasto: [previo()] } });
    const r = (await w.svc.create(dto(), USER, Rol.ADMIN)) as Row & {
      conciliacion: Row;
    };
    expect(insertsDeGasto(w.log)).toHaveLength(0);
    expect(
      w.conciliacion.prevalidarCargosParaGastoNuevo,
    ).not.toHaveBeenCalled();
    expect(w.conciliacion.ligarCargosAGasto).toHaveBeenCalledWith(
      'g-previo',
      [C1, C2],
      USER,
    );
    expect(r.id).toBe('g-previo');
    expect(r.conciliacion.idempotente).toBe(true);
  });

  it('otros datos con la misma llave ⇒ 409 CLIENT_REQUEST_ID_EN_USO sin ligar', async () => {
    const w = armar({ db: { gasto: [previo({ monto: 9600 })] } });
    const r = await rechazo(w.svc.create(dto(), USER, Rol.ADMIN));
    expect([r.status, r.body.error, r.body.message, r.body.details]).toEqual([
      409,
      'CLIENT_REQUEST_ID_EN_USO',
      'Esa captura ya registró un gasto con otros datos: búscalo en Gastos antes de volver a intentarlo.',
      { gasto_id: 'g-previo' },
    ]);
    expect(w.conciliacion.ligarCargosAGasto).not.toHaveBeenCalled();
  });

  it('si la liga del replay falla, el gasto NO se retira (es de un intento anterior)', async () => {
    const w = armar({
      db: { gasto: [previo()] },
      ligar: jest.fn().mockRejectedValue(errorCargosAGastoNoDisponible()),
    });
    const r = await rechazo(w.svc.create(dto(), USER, Rol.ADMIN));
    expect([r.status, r.body.error]).toEqual([
      503,
      'CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE',
    ]);
    expect(r.body.details).toMatchObject({ gasto_id: 'g-previo' });
    expect(w.db.gasto).toHaveLength(1);
  });

  it('carrera de la llave (23505 al insertar) ⇒ el replay de siempre', async () => {
    let ya = false;
    const w = armar({
      fake: {
        antes: (op, d) => {
          if (op.tabla === 'gasto' && op.op === 'insert' && !ya) {
            ya = true;
            d.gasto.push(previo({ id: 'g-otro-intento' }));
            return {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "uq_gasto_client_request"',
            };
          }
        },
      },
    });
    const r = (await w.svc.create(dto(), USER, Rol.ADMIN)) as Row & {
      conciliacion: Row;
    };
    expect(r.id).toBe('g-otro-intento');
    expect(r.conciliacion.idempotente).toBe(true);
    expect(w.conciliacion.ligarCargosAGasto).toHaveBeenCalledWith(
      'g-otro-intento',
      [C1, C2],
      USER,
    );
  });
});

describe('PATCH con la llave', () => {
  it('400 CONCILIAR_SOLO_AL_CREAR antes de tocar nada', async () => {
    const w = armar({
      db: {
        gasto: [
          { id: 'g-1', monto: 10, moneda: 'MXN', medio_pago: 'TRANSFERENCIA' },
        ],
      },
    });
    const r = await rechazo(
      w.svc.update(
        'g-1',
        { conciliar_con_movimientos: [C1, C2] },
        USER,
        Rol.ADMIN,
      ),
    );
    expect([r.status, r.body.error, r.body.message]).toEqual([
      400,
      'CONCILIAR_SOLO_AL_CREAR',
      'Los cargos del banco se vinculan al crear el gasto; para un gasto que ya existe usa «Vincular a un gasto» en Conciliación.',
    ]);
    expect(escrituras(w.log)).toHaveLength(0);
  });
});
