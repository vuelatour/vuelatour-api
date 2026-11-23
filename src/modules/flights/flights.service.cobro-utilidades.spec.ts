// Mismos stubs que el resto de los specs de flights: notifications arrastra
// el gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK de IA y
// pilots el stack de push.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pilots/pilots.service', () => ({ PilotsService: class {} }));

import { FlightsService } from './flights.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';
import type { CreateCobroDto } from './dto/cobros.dto';
import { Moneda } from '../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../quotes/dto/calculate-quote.dto';
import { Rol } from '../../common/types/auth.types';
import {
  COLUMNAS_AUSENTES_COBROS,
  fakeCobrosParciales,
  type ErrorBd,
  type OpcionesCobrosParciales,
  type Row,
  type Tablas,
} from '../conciliacion/cobros-parciales.fixture-spec';

/**
 * COBRO DE UN VUELO CON UTILIDADES DEL SOCIO — el lado del COBRO (23-nov-2026,
 * API 0.0.148, invariante 143). El cobro es un `cobro_vuelo` normal (método
 * `OTRO`) ligado 1 a 1 a una entrega al socio por `reparto_pago_id`:
 *
 *  - ALTA: con la opción interna `utilidades` NO hay insert suelto: el cobro
 *    entra con su entrega por la función de BD (una transacción);
 *  - LECTURA: la lista de cobros dice `utilidades {socio, avión, mes}`;
 *  - CORRECCIÓN: su dinero, fecha, método y cuenta no cambian (409);
 *  - BAJA: solo Dirección/Facturación, y da de baja la entrega.
 *
 * Caso real: el vuelo #498 de Macedo en N621TX (28-oct-2026, $44,174.30).
 */
const USER = 'u-direccion';
const V498 = 'v498';
const ENTREGA = 'e-498';
const MACEDO = 's-macedo';
const N621TX = 'a-n621tx';
const KEY = 'eeeeeeee-0000-4000-8000-000000000498';

/** La fila que arma `RepartoPagoService.prepararEntregaDeVuelo`. */
const FILA_ENTREGA = {
  socio_id: MACEDO,
  aeronave_id: N621TX,
  periodo: '2026-10-01',
  monto: 44174.3,
  moneda: 'MXN',
  tc_usd_mxn: 18.6673,
  monto_usd: 2366.4,
  monto_mxn: 44174.3,
  saldo_snapshot_mxn: 81181.23,
  fecha_pago: '2026-10-28',
  metodo: 'OTRO',
  referencia: 'Vuelo #498',
  notas: null,
  entregado_por: USER,
  client_request_id: KEY,
  created_by: USER,
};

/** El embed de la entrega tal como lo devuelve PostgREST. */
const entregaEmbed = (extra: Row = {}): Row => ({
  id: ENTREGA,
  socio_id: MACEDO,
  aeronave_id: N621TX,
  periodo: '2026-10-01',
  fecha_pago: '2026-10-28',
  socio: { nombre: 'Macedo' },
  aeronave: { matricula: 'N621TX' },
  ...extra,
});

const cobro = (id: string, extra: Row = {}): Row => ({
  id,
  vuelo_id: V498,
  monto: 1000,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  tc_usd_mxn: 18.6673,
  comision_banco_pct: null,
  comision_banco_monto: null,
  cuenta_destino: 'Scotiabank Pesos',
  referencia: null,
  fecha_cobro: '2026-10-28T17:00:00Z',
  foto_voucher_url: null,
  registrado_por: null,
  notas: null,
  created_at: '2026-10-28T17:00:00Z',
  updated_at: '2026-10-28T17:00:00Z',
  cobro_grupo_id: null,
  grupo_factor: null,
  factura_emitida_id: null,
  ...extra,
});

/** Un cobro YA pagado con utilidades (con su entrega viva). */
const cobroConUtilidades = (extra: Row = {}): Row =>
  cobro('c-util', {
    monto: 44174.3,
    metodo_cobro: 'OTRO',
    cuenta_destino: null,
    reparto_pago_id: ENTREGA,
    entrega: entregaEmbed(),
    ...extra,
  });

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    vuelo: [
      {
        id: V498,
        folio: 498,
        cliente_id: null,
        tc_usd_mxn: 18.6673,
        estado: 'COMPLETADO',
        metodo_cobro: 'TRANSFERENCIA',
        monto_total_usd: 2366.4,
      },
    ],
    cobro_vuelo: [],
    reparto_pago: [],
    cobro_grupo: [],
    vuelo_grupo: [],
    movimiento_bancario: [],
    movimiento_bancario_cobro: [],
    factura_emitida: [],
    factura_emitida_vuelo: [],
    cuenta_bancaria: [],
    usuario: [],
    ...extra,
  };
}

const entregaViva = (extra: Row = {}): Row => ({
  id: ENTREGA,
  ...FILA_ENTREGA,
  deleted_at: null,
  deleted_by: null,
  motivo_baja: null,
  updated_by: null,
  ...extra,
});

interface OpcionesArmar extends OpcionesCobrosParciales {
  /** Error con que responde la función de BD del alta. */
  errorAlta?: ErrorBd;
}

function armar(db: Tablas, opts: OpcionesArmar = {}) {
  const f = fakeCobrosParciales(db, {
    ...opts,
    ausentes: opts.ausentes ?? COLUMNAS_AUSENTES_COBROS,
  });
  // La función de BD `cobro_utilidades_registrar`: las DOS filas o ninguna.
  const altas: Array<{ p_entrega: Row; p_cobro: Row }> = [];
  const servicio = f.supabase.service as unknown as {
    rpc: (nombre: string, args: Row) => Promise<unknown>;
  };
  const rpcBase = servicio.rpc.bind(servicio);
  servicio.rpc = (nombre: string, args: Row) => {
    if (nombre !== 'cobro_utilidades_registrar') return rpcBase(nombre, args);
    altas.push(args as { p_entrega: Row; p_cobro: Row });
    if (opts.errorAlta) {
      return Promise.resolve({ data: null, error: opts.errorAlta });
    }
    const entregaId = `e-${altas.length}`;
    const cobroId = `c-${altas.length}`;
    (db.reparto_pago ??= []).push({
      id: entregaId,
      deleted_at: null,
      ...(args.p_entrega as Row),
    });
    db.cobro_vuelo.push(
      cobro(cobroId, {
        cuenta_destino: null,
        ...(JSON.parse(JSON.stringify(args.p_cobro)) as Row),
        reparto_pago_id: entregaId,
      }),
    );
    return Promise.resolve({
      data: { entrega_id: entregaId, cobro_id: cobroId },
      error: null,
    });
  };
  const notifyRole = jest.fn().mockResolvedValue(true);
  const svc = new FlightsService(
    f.supabase,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {
      notifyUser: jest.fn().mockResolvedValue(true),
      notifyRole,
      notifyUserDetallado: jest.fn().mockResolvedValue({ notificado: true }),
    } as unknown as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {
      numero: jest.fn().mockResolvedValue(8.857),
    } as unknown as ConfiguracionService,
    {} as PilotsService,
  );
  const refrescar = jest
    .spyOn(svc, 'refreshCobradoFlag')
    .mockResolvedValue({ antes: false, despues: true });
  return { svc, db, log: f.log, altas, refrescar };
}

const SIN_SONDA = [...COLUMNAS_AUSENTES_COBROS, 'reparto_pago_id'];

/** El DTO que arma `CobroUtilidadesService` (método `OTRO`, con llave). */
const dto = (extra: Partial<CreateCobroDto> = {}): CreateCobroDto => ({
  monto: 44174.3,
  moneda: Moneda.MXN,
  metodo_cobro: MetodoPago.OTRO,
  tc_usd_mxn: 18.6673,
  fecha_cobro: new Date('2026-10-28T17:00:00.000Z'),
  client_request_id: KEY,
  ...extra,
});

const conUtilidades = { utilidades: { entrega: FILA_ENTREGA } };

async function error(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  const r = (e as { getResponse?: () => unknown } | null)?.getResponse?.() as
    | { error?: string; message?: string; details?: Record<string, unknown> }
    | undefined;
  return {
    e,
    status:
      (e as { getStatus?: () => number } | null)?.getStatus?.() ??
      (e ? 500 : null),
    code: r?.error ?? null,
    message: r?.message ?? (e instanceof Error ? e.message : null),
    details: r?.details ?? null,
  };
}

const de = (
  log: Array<{ tabla: string; op: string; sel: string }>,
  tabla: string,
  op: string,
) => log.filter((o) => o.tabla === tabla && o.op === op);

describe('createCobro con utilidades del socio: el cobro entra CON su entrega', () => {
  it('una sola escritura (la función de BD) con las dos filas; ni un insert suelto; el cobro vuelve leído y la bandera se recalcula', async () => {
    const { svc, db, log, altas, refrescar } = armar(mundo());
    const r = await svc.createCobro(
      V498,
      dto({ notas: 'lo pidió el socio' }),
      USER,
      Rol.DIRECCION,
      undefined,
      undefined,
      conUtilidades,
    );
    expect(altas).toHaveLength(1);
    // La entrega viaja TAL CUAL la armó «Pagos a socios».
    expect(altas[0].p_entrega).toEqual(FILA_ENTREGA);
    // El cobro: el de siempre, método OTRO, sin comisión ni cuenta.
    expect(JSON.parse(JSON.stringify(altas[0].p_cobro))).toEqual({
      vuelo_id: V498,
      monto: 44174.3,
      moneda: 'MXN',
      metodo_cobro: 'OTRO',
      tc_usd_mxn: 18.6673,
      comision_banco_pct: null,
      comision_banco_monto: null,
      cuenta_destino: null,
      fecha_cobro: '2026-10-28T17:00:00.000Z',
      registrado_por: USER,
      notas: 'lo pidió el socio',
      client_request_id: KEY,
      cobro_grupo_id: null,
      grupo_factor: null,
      created_by: USER,
      updated_by: USER,
    });
    expect(de(log, 'cobro_vuelo', 'insert')).toHaveLength(0);
    expect(de(log, 'reparto_pago', 'insert')).toHaveLength(0);
    expect(r).toMatchObject({
      id: 'c-1',
      vuelo_id: V498,
      monto: 44174.3,
      metodo_cobro: 'OTRO',
    });
    expect(db.cobro_vuelo).toHaveLength(1);
    expect(db.reparto_pago).toHaveLength(1);
    expect(refrescar).toHaveBeenCalledWith(V498, USER);
  });

  it('la misma llave otra vez ⇒ el cobro que ya quedó (idempotente), sin volver a escribir', async () => {
    const { svc, db, altas } = armar(mundo());
    await svc.createCobro(
      V498,
      dto(),
      USER,
      Rol.DIRECCION,
      undefined,
      undefined,
      conUtilidades,
    );
    const r = await svc.createCobro(
      V498,
      dto(),
      USER,
      Rol.DIRECCION,
      undefined,
      undefined,
      conUtilidades,
    );
    expect(r).toMatchObject({ id: 'c-1', idempotente: true });
    expect(altas).toHaveLength(1);
    expect(db.cobro_vuelo).toHaveLength(1);
  });

  it('el saldo del vuelo manda ANTES de escribir: un monto que lo rebasa ⇒ 409 COBRO_EXCEDE_SALDO y la función de BD ni se llama', async () => {
    const { svc, altas } = armar(mundo());
    const r = await error(
      svc.createCobro(
        V498,
        dto({ monto: 60000 }),
        USER,
        Rol.DIRECCION,
        undefined,
        undefined,
        conUtilidades,
      ),
    );
    expect([r.status, r.code]).toEqual([409, 'COBRO_EXCEDE_SALDO']);
    expect(altas).toHaveLength(0);
  });

  it.each<[string, ErrorBd, number, string]>([
    [
      'candado de la BD (el cobro y la entrega valen distinto)',
      {
        code: '23514',
        hint: 'UTILIDADES_MONTO_DISTINTO',
        message:
          'UTILIDADES_MONTO_DISTINTO: el cobro (44174.30 MXN) y la entrega al socio (500.00 MXN) deben valer lo mismo',
      },
      409,
      'UTILIDADES_MONTO_DISTINTO',
    ],
    [
      'la función todavía no existe',
      {
        code: 'PGRST202',
        message:
          'Could not find the function public.cobro_utilidades_registrar in the schema cache',
      },
      503,
      'COBRO_UTILIDADES_NO_DISPONIBLE',
    ],
    [
      'un CHECK de la entrega',
      {
        code: '23514',
        message: 'violates check constraint "reparto_pago_monto_chk"',
      },
      400,
      'COBRO_UTILIDADES_INVALIDO',
    ],
    [
      'el socio o el avión ya no existe',
      { code: '23503', message: 'violates foreign key constraint' },
      400,
      'COBRO_UTILIDADES_REFERENCIA_INVALIDA',
    ],
  ])(
    '%s ⇒ error legible y NADA escrito',
    async (_caso, errorAlta, status, code) => {
      const { svc, db, refrescar } = armar(mundo(), { errorAlta });
      const r = await error(
        svc.createCobro(
          V498,
          dto(),
          USER,
          Rol.DIRECCION,
          undefined,
          undefined,
          conUtilidades,
        ),
      );
      expect([r.status, r.code]).toEqual([status, code]);
      expect(db.cobro_vuelo).toHaveLength(0);
      expect(db.reparto_pago).toHaveLength(0);
      expect(refrescar).not.toHaveBeenCalled();
    },
  );

  it('choque de la llave en la ENTREGA (otra alta ganó la carrera con otro vuelo) ⇒ 409 CLIENT_REQUEST_ID_EN_USO, jamás 500', async () => {
    const { svc } = armar(mundo(), {
      errorAlta: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "uq_reparto_pago_client_request"',
      },
    });
    const r = await error(
      svc.createCobro(
        V498,
        dto(),
        USER,
        Rol.DIRECCION,
        undefined,
        undefined,
        conUtilidades,
      ),
    );
    expect([r.status, r.code]).toEqual([409, 'CLIENT_REQUEST_ID_EN_USO']);
  });

  it('un cobro NORMAL (sin la opción interna) sigue entrando con su insert de siempre', async () => {
    const { svc, log, altas } = armar(mundo());
    await svc.createCobro(
      V498,
      {
        monto: 1000,
        moneda: Moneda.MXN,
        metodo_cobro: MetodoPago.TRANSFERENCIA,
        cuenta_destino: 'Scotiabank Pesos',
      },
      USER,
      Rol.ADMIN,
    );
    expect(altas).toHaveLength(0);
    expect(de(log, 'cobro_vuelo', 'insert')).toHaveLength(1);
  });
});

describe('listCobros: el cobro dice de qué socio, avión y mes salieron sus utilidades', () => {
  it('con la sonda: `utilidades {…}` en el cobro ligado y null en el normal; una sola lectura extra', async () => {
    const { svc, log } = armar(
      mundo({ cobro_vuelo: [cobroConUtilidades(), cobro('c-normal')] }),
    );
    const cobros = await svc.listCobros(V498);
    const porId = new Map(cobros.map((c) => [c.id as string, c]));
    expect(porId.get('c-util')?.utilidades).toEqual({
      entrega_id: ENTREGA,
      socio_id: MACEDO,
      socio_nombre: 'Macedo',
      aeronave_id: N621TX,
      matricula: 'N621TX',
      mes: '2026-10',
    });
    expect(porId.get('c-normal')?.utilidades).toBeNull();
    // La lista nombra la columna y solo hay UNA lectura con el embed.
    const selects = de(log, 'cobro_vuelo', 'select');
    expect(
      selects.some((s) => /grupo_factor.*, reparto_pago_id$/.test(s.sel)),
    ).toBe(true);
    expect(
      selects.filter((s) => s.sel.includes('entrega:reparto_pago_id')),
    ).toHaveLength(1);
  });

  it('sin cobros ligados: ni una lectura extra', async () => {
    const { svc, log } = armar(mundo({ cobro_vuelo: [cobro('c-normal')] }));
    const cobros = await svc.listCobros(V498);
    expect(cobros[0].utilidades).toBeNull();
    const selects = de(log, 'cobro_vuelo', 'select');
    expect(
      selects.filter((s) => s.sel.includes('entrega:reparto_pago_id')),
    ).toHaveLength(0);
  });

  it('SIN la migración: la columna no se nombra y la llave no viaja', async () => {
    const { svc, log } = armar(mundo({ cobro_vuelo: [cobro('c-normal')] }), {
      ausentes: SIN_SONDA,
    });
    const cobros = await svc.listCobros(V498);
    expect(cobros).toHaveLength(1);
    expect('utilidades' in cobros[0]).toBe(false);
    const lista = de(log, 'cobro_vuelo', 'select').filter((s) =>
      s.sel.includes('grupo_factor'),
    );
    expect(lista.every((s) => !s.sel.includes('reparto_pago_id'))).toBe(true);
  });
});

describe('updateCobro: el dinero de un cobro con utilidades no se corrige', () => {
  const conLigado = () =>
    armar(
      mundo({
        cobro_vuelo: [cobroConUtilidades()],
        reparto_pago: [entregaViva()],
      }),
    );

  it.each<[string, Record<string, unknown>, string[]]>([
    ['monto', { monto: 40000 }, ['monto']],
    ['moneda', { moneda: 'USD' }, ['moneda']],
    ['método', { metodo_cobro: 'TRANSFERENCIA' }, ['metodo_cobro']],
    ['T.C.', { tc_usd_mxn: 19 }, ['tc_usd_mxn']],
    [
      'fecha',
      { fecha_cobro: new Date('2026-11-02T17:00:00Z') },
      ['fecha_cobro'],
    ],
    [
      'cuenta destino',
      { cuenta_destino: 'Scotiabank Pesos' },
      ['cuenta_destino'],
    ],
    [
      'comisión bancaria',
      { comision_banco_monto: 100 },
      ['comision_banco_monto'],
    ],
  ])(
    'cambiar %s ⇒ 409 COBRO_CON_UTILIDADES y nada se escribe',
    async (_c, cambio, campos) => {
      const { svc, log, db } = conLigado();
      const r = await error(svc.updateCobro('c-util', cambio, USER));
      expect([r.status, r.code]).toEqual([409, 'COBRO_CON_UTILIDADES']);
      expect(r.details).toEqual({ cobro_id: 'c-util', campos });
      expect(de(log, 'cobro_vuelo', 'update')).toHaveLength(0);
      expect(db.cobro_vuelo[0].monto).toBe(44174.3);
    },
  );

  it('las notas y la referencia sí se corrigen, también reenviando el MISMO dinero (el panel manda el formulario completo)', async () => {
    const { svc, db } = conLigado();
    await svc.updateCobro(
      'c-util',
      {
        monto: 44174.3,
        moneda: Moneda.MXN,
        metodo_cobro: MetodoPago.OTRO,
        tc_usd_mxn: 18.6673,
        fecha_cobro: new Date('2026-10-28T17:00:00Z'),
        notas: 'Autorizó Ale',
      },
      USER,
    );
    expect(db.cobro_vuelo[0]).toMatchObject({
      notas: 'Autorizó Ale',
      monto: 44174.3,
    });
  });

  it('un cobro NORMAL se corrige como siempre', async () => {
    const { svc, db } = armar(mundo({ cobro_vuelo: [cobro('c-normal')] }));
    await svc.updateCobro('c-normal', { monto: 1200 }, USER);
    expect(db.cobro_vuelo[0].monto).toBe(1200);
  });
});

describe('deleteCobro: quitar el cobro con utilidades da de baja su entrega', () => {
  const conLigado = (opts: OpcionesArmar = {}) =>
    armar(
      mundo({
        cobro_vuelo: [cobroConUtilidades()],
        reparto_pago: [entregaViva()],
      }),
      opts,
    );

  it('Dirección (o Facturación): el cobro se borra y la entrega queda dada de baja con quién y por qué', async () => {
    const { svc, db, log, refrescar } = conLigado();
    await svc.deleteCobro('c-util', USER, { rol: Rol.DIRECCION });
    expect(db.cobro_vuelo).toHaveLength(0);
    expect(db.reparto_pago[0]).toMatchObject({
      id: ENTREGA,
      deleted_by: USER,
      updated_by: USER,
      motivo_baja: 'Se quitó el cobro con utilidades del vuelo',
    });
    expect(db.reparto_pago[0].deleted_at).toEqual(expect.any(String));
    // Antes del DELETE el cobro quedó firmado (el trigger de baja lo lee).
    const ops = log.filter(
      (o) => o.tabla === 'cobro_vuelo' && o.op !== 'select',
    );
    expect(ops.map((o) => o.op)).toEqual(['update', 'delete']);
    expect((ops[0] as { cuerpo?: Row }).cuerpo).toEqual({ updated_by: USER });
    expect(refrescar).toHaveBeenCalledWith(V498, USER);
  });

  it('con el trigger de baja ya aplicado (la entrega llega dada de baja) el segundo paso no cambia nada', async () => {
    const yaDeBaja = entregaViva({
      deleted_at: '2026-11-23T18:00:00Z',
      deleted_by: 'u-trigger',
      motivo_baja: 'Se quitó el cobro con utilidades del vuelo',
    });
    const { svc, db } = armar(
      mundo({ cobro_vuelo: [cobroConUtilidades()], reparto_pago: [yaDeBaja] }),
    );
    await svc.deleteCobro('c-util', USER, { rol: Rol.FACTURACION });
    expect(db.cobro_vuelo).toHaveLength(0);
    expect(db.reparto_pago[0]).toMatchObject({
      deleted_at: '2026-11-23T18:00:00Z',
      deleted_by: 'u-trigger',
    });
  });

  it.each([Rol.ADMIN, Rol.COORDINADOR])(
    '%s no lo quita (movería la cuenta del socio) ⇒ 403 y todo sigue igual',
    async (rol) => {
      const { svc, db } = conLigado();
      const r = await error(svc.deleteCobro('c-util', USER, { rol }));
      expect([r.status, r.code]).toEqual([
        403,
        'COBRO_CON_UTILIDADES_SOLO_DIRECCION',
      ]);
      expect(db.cobro_vuelo).toHaveLength(1);
      expect(db.reparto_pago[0].deleted_at).toBeNull();
    },
  );

  it('si la baja de la entrega falla tres veces: 500 que dice QUÉ entrega dar de baja a mano (el cobro ya no existe)', async () => {
    const { svc, db, log } = conLigado({
      fallos: { 'reparto_pago:update': { code: '57014', message: 'timeout' } },
    });
    const r = await error(
      svc.deleteCobro('c-util', USER, { rol: Rol.DIRECCION }),
    );
    expect([r.status, r.code]).toEqual([500, 'ENTREGA_DE_VUELO_SIN_BAJA']);
    expect(r.details).toMatchObject({
      entrega_id: ENTREGA,
      cobro_id: 'c-util',
    });
    expect(r.message).toContain('Pagos a socios');
    expect(de(log, 'reparto_pago', 'update')).toHaveLength(3);
    expect(db.cobro_vuelo).toHaveLength(0);
  });

  it('un cobro NORMAL lo borra ADMIN como siempre, sin tocar entregas', async () => {
    const { svc, db, log } = armar(
      mundo({
        cobro_vuelo: [cobro('c-normal')],
        reparto_pago: [entregaViva()],
      }),
    );
    await svc.deleteCobro('c-normal', USER, { rol: Rol.ADMIN });
    expect(db.cobro_vuelo).toHaveLength(0);
    expect(de(log, 'reparto_pago', 'update')).toHaveLength(0);
    expect(db.reparto_pago[0].deleted_at).toBeNull();
  });

  it('SIN la migración: el borrado de siempre (la columna ni se nombra)', async () => {
    const { svc, db, log } = armar(
      mundo({ cobro_vuelo: [cobro('c-normal')] }),
      {
        ausentes: SIN_SONDA,
      },
    );
    await svc.deleteCobro('c-normal', USER, { rol: Rol.ADMIN });
    expect(db.cobro_vuelo).toHaveLength(0);
    const selects = de(log, 'cobro_vuelo', 'select');
    // Solo la sonda nombra la columna (y recibe 42703).
    expect(
      selects.filter((s) => s.sel.includes('entrega:reparto_pago_id')),
    ).toHaveLength(0);
  });
});
