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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FlightsService } from './flights.service';
import { FlightsController } from './flights.controller';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';
import type { FlightReportService } from './flight-report.service';
import type { CobroReciboService } from './cobro-recibo.service';
import type { FacturaClienteService } from './factura-cliente.service';
import type { CreateCobroDto } from './dto/cobros.dto';
import { Moneda } from '../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../quotes/dto/calculate-quote.dto';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  COLUMNAS_AUSENTES_COBROS,
  fakeCobrosParciales,
  type OpcionesCobrosParciales,
  type Row,
  type Tablas,
} from '../conciliacion/cobros-parciales.fixture-spec';

/**
 * FACTURAS POR COBRO (16-oct-2026, API 0.0.82, invariante 84) — el cobro
 * dice qué factura lo AMPARA (`cobro_vuelo.factura_emitida_id`). Se
 * congela contra la BD en memoria:
 * - 503 COBRO_FACTURA_NO_DISPONIBLE sin la sonda ANTES de insertar y
 *   DESPUÉS del replay idempotente;
 * - POST/PATCH con cada 400/409 (reembolso, cancelada, de otro vuelo);
 * - un conciliado PARCIAL cambia de factura sin COBRO_CONCILIADO (no es
 *   dinero); PATCH `null` suelta;
 * - el controller descarta el campo a COORDINADOR/PILOTO;
 * - `adjuntarSobres`: `factura_emitida {id, etiqueta}`, ≤ 200 ids por
 *   consulta, llave omitida para campo y sin sonda;
 * - carrera: el 23514 del trigger A ⇒ el MISMO 409 con details, nunca 500;
 * - los 7 selects de `cobro_vuelo` pasan por `cobroCols(disponible)`.
 */
const USER = 'u-oficina';
const V332 = 'v332';
const V333 = 'v333';
const F0420 = 'f-0420';
const FCANC = 'f-canc';
const FOTRO = 'f-otro';
const CTA = 'cta-mxn';

const cobro = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  vuelo_id: V332,
  monto,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  tc_usd_mxn: 17.4,
  comision_banco_pct: null,
  comision_banco_monto: null,
  cuenta_destino: 'Scotiabank Pesos',
  referencia: null,
  fecha_cobro: '2026-09-21T17:00:00Z',
  foto_voucher_url: null,
  registrado_por: null,
  notas: null,
  created_at: '2026-09-21T17:00:00Z',
  updated_at: '2026-09-21T17:00:00Z',
  cobro_grupo_id: null,
  grupo_factor: null,
  factura_emitida_id: null,
  ...extra,
});

const factura = (id: string, folio: string, extra: Row = {}): Row => ({
  id,
  serie: 'A',
  folio,
  estatus: 'VIGENTE',
  deleted_at: null,
  ...extra,
});

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'EJE SCOTIA',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
    ],
    vuelo: [
      {
        id: V332,
        folio: 332,
        cliente_id: null,
        tc_usd_mxn: 17.4,
        estado: 'COMPLETADO',
        metodo_cobro: null,
        monto_total_usd: 4172.44,
      },
      {
        id: V333,
        folio: 333,
        cliente_id: null,
        tc_usd_mxn: 17.4,
        estado: 'COMPLETADO',
        metodo_cobro: null,
        monto_total_usd: 1000,
      },
    ],
    cobro_vuelo: [cobro('c-68208', 68208), cobro('c-977', 977.45)],
    factura_emitida: [
      factura(F0420, '0420'),
      factura(FCANC, '0410', { estatus: 'CANCELADA' }),
      factura(FOTRO, '0430'),
    ],
    factura_emitida_vuelo: [
      { factura_id: F0420, vuelo_id: V332 },
      { factura_id: FCANC, vuelo_id: V332 },
      { factura_id: FOTRO, vuelo_id: V333 },
    ],
    cobro_grupo: [],
    vuelo_grupo: [],
    movimiento_bancario: [],
    movimiento_bancario_cobro: [],
    usuario: [],
    ...extra,
  };
}

function armar(db: Tablas, opts: OpcionesCobrosParciales = {}) {
  const f = fakeCobrosParciales(db, {
    ...opts,
    ausentes: opts.ausentes ?? COLUMNAS_AUSENTES_COBROS,
  });
  const svc = new FlightsService(
    f.supabase,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {
      notifyUser: jest.fn().mockResolvedValue(true),
      notifyRole: jest.fn().mockResolvedValue(true),
      notifyUserDetallado: jest.fn().mockResolvedValue({ notificado: true }),
    } as unknown as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {
      numero: jest.fn().mockResolvedValue(8.857),
    } as unknown as ConfiguracionService,
    {} as PilotsService,
  );
  // La bandera `cobrado` lee el vuelo completo: fuera de este spec.
  jest.spyOn(svc, 'refreshCobradoFlag').mockResolvedValue(undefined);
  return { svc, db, log: f.log, escrituras: f.escrituras };
}

const SIN_SONDA = [...COLUMNAS_AUSENTES_COBROS, 'factura_emitida_id'];

const dto = (extra: Partial<CreateCobroDto> = {}): CreateCobroDto => ({
  monto: 1700,
  moneda: Moneda.MXN,
  metodo_cobro: MetodoPago.TRANSFERENCIA,
  cuenta_destino: 'Scotiabank Pesos',
  ...extra,
});

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
    code: r?.error ?? null,
    message: r?.message ?? null,
    details: r?.details ?? null,
  };
}

const inserts = (log: Array<{ tabla: string; op: string }>) =>
  log.filter((o) => o.tabla === 'cobro_vuelo' && o.op === 'insert');

describe('POST :id/payments con factura_emitida_id', () => {
  it('con la sonda: el INSERT lleva la columna y la relectura la trae', async () => {
    const { svc, db, log } = armar(mundo());
    const r = await svc.createCobro(
      V332,
      dto({ factura_emitida_id: F0420 }),
      USER,
      Rol.ADMIN,
    );
    expect(r.factura_emitida_id).toBe(F0420);
    const ins = inserts(log)[0] as { cuerpo?: Row };
    expect(ins.cuerpo?.factura_emitida_id).toBe(F0420);
    expect(db.cobro_vuelo.at(-1)?.factura_emitida_id).toBe(F0420);
    // Sin el campo: el insert de siempre (sin la llave).
    const sin = armar(mundo());
    await sin.svc.createCobro(V332, dto(), USER, Rol.ADMIN);
    const insSin = inserts(sin.log)[0] as { cuerpo?: Row };
    expect('factura_emitida_id' in (insSin.cuerpo ?? {})).toBe(false);
  });

  it('SIN la sonda: con el campo ⇒ 503 COBRO_FACTURA_NO_DISPONIBLE sin escribir nada; sin el campo ⇒ 201 con selects sin la columna', async () => {
    const { svc, log } = armar(mundo(), { ausentes: SIN_SONDA });
    const r = await error(
      svc.createCobro(
        V332,
        dto({ factura_emitida_id: F0420 }),
        USER,
        Rol.ADMIN,
      ),
    );
    expect(r.e).toBeInstanceOf(ServiceUnavailableException);
    expect(r.code).toBe('COBRO_FACTURA_NO_DISPONIBLE');
    expect(r.message).toBe(
      'Todavía no se puede asignar factura a un cobro: falta aplicar la migración 20261016000001.',
    );
    expect(inserts(log)).toEqual([]);
    const ok = armar(mundo(), { ausentes: SIN_SONDA });
    const fila = await ok.svc.createCobro(V332, dto(), USER, Rol.ADMIN);
    expect(fila.id).toBeTruthy();
    expect(
      ok.log
        .filter(
          (o) =>
            o.tabla === 'cobro_vuelo' &&
            o.op === 'select' &&
            o.sel.includes('vuelo_id'),
        )
        .every((o) => !o.sel.includes('factura_emitida_id')),
    ).toBe(true);
  });

  it('el replay idempotente va ANTES del 503: un reintento con client_request_id devuelve el cobro que ya existe', async () => {
    const key = 'cccccccc-0000-4000-8000-000000000001';
    const { svc, log } = armar(
      mundo({ cobro_vuelo: [cobro('c-ya', 1700, { client_request_id: key })] }),
      { ausentes: SIN_SONDA },
    );
    const r = await svc.createCobro(
      V332,
      dto({ client_request_id: key, factura_emitida_id: F0420 }),
      USER,
      Rol.ADMIN,
    );
    expect(r).toMatchObject({ id: 'c-ya', idempotente: true });
    expect(inserts(log)).toEqual([]);
  });

  it('factura CANCELADA ⇒ 409 FACTURA_NO_VIGENTE; factura de OTRO vuelo ⇒ 409 FACTURA_NO_LIGADA_AL_VUELO con el folio; nada se inserta', async () => {
    const a = armar(mundo());
    const canc = await error(
      a.svc.createCobro(
        V332,
        dto({ factura_emitida_id: FCANC }),
        USER,
        Rol.ADMIN,
      ),
    );
    expect(canc.e).toBeInstanceOf(ConflictException);
    expect(canc.code).toBe('FACTURA_NO_VIGENTE');
    expect(canc.message).toBe(
      'La factura A-0410 ya no está vigente (o no existe): recarga la página y elige otra.',
    );
    expect(canc.details).toEqual({
      factura_id: FCANC,
      estatus: 'CANCELADA',
      borrada: false,
    });
    const otro = await error(
      a.svc.createCobro(
        V332,
        dto({ factura_emitida_id: FOTRO }),
        USER,
        Rol.ADMIN,
      ),
    );
    expect(otro.code).toBe('FACTURA_NO_LIGADA_AL_VUELO');
    expect(otro.message).toBe(
      'La factura A-0430 no está ligada al vuelo #332. Agrégale el vuelo en Facturas emitidas → Editar → Vuelos y vuelve a intentar.',
    );
    expect(otro.details).toEqual({
      factura_id: FOTRO,
      vuelo_id: V332,
      folio: 332,
    });
    const inexistente = await error(
      a.svc.createCobro(
        V332,
        dto({ factura_emitida_id: '00000000-0000-4000-8000-000000000000' }),
        USER,
        Rol.ADMIN,
      ),
    );
    expect(inexistente.code).toBe('FACTURA_NO_VIGENTE');
    expect(inserts(a.log)).toEqual([]);
  });

  it('carrera: el INSERT rebota 23514 del trigger A ⇒ el MISMO 409 con los details de la BD (nunca 500)', async () => {
    const { svc } = armar(mundo(), {
      antes: (op) =>
        op.tabla === 'cobro_vuelo' && op.op === 'insert'
          ? {
              code: '23514',
              message: 'FACTURA_NO_VIGENTE: la factura ya no está vigente',
              hint: 'FACTURA_NO_VIGENTE',
              details: JSON.stringify({
                factura_id: F0420,
                estatus: 'CANCELADA',
                borrada: false,
              }),
            }
          : undefined,
    });
    const r = await error(
      svc.createCobro(
        V332,
        dto({ factura_emitida_id: F0420 }),
        USER,
        Rol.ADMIN,
      ),
    );
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('FACTURA_NO_VIGENTE');
    expect(r.message).toContain('A-0420');
    expect(r.details).toEqual({
      factura_id: F0420,
      estatus: 'CANCELADA',
      borrada: false,
    });
  });

  it('el controller DESCARTA el campo a COORDINADOR y PILOTO (jamás un 400): solo ADMIN/FACTURACION lo mandan', async () => {
    const createCobro = jest.fn().mockResolvedValue({ id: 'c-new' });
    const flights = {
      assertAccess: jest.fn().mockResolvedValue(undefined),
      createCobro,
    } as unknown as FlightsService;
    const ctrl = new FlightsController(
      flights,
      {} as FlightReportService,
      {} as CobroReciboService,
      {} as FacturaClienteService,
    );
    const dtoEnviado = (): CreateCobroDto =>
      (
        createCobro.mock.calls as unknown as Array<[string, CreateCobroDto]>
      )[0][1];
    const usuario = (rol: Rol): AuthenticatedUser =>
      ({ userId: USER, rol, authId: 'auth' }) as unknown as AuthenticatedUser;
    for (const rol of [Rol.COORDINADOR, Rol.PILOTO]) {
      createCobro.mockClear();
      await ctrl.createPayment(
        V332,
        dto({ factura_emitida_id: F0420 }),
        usuario(rol),
      );
      expect('factura_emitida_id' in dtoEnviado()).toBe(false);
    }
    for (const rol of [Rol.ADMIN, Rol.FACTURACION]) {
      createCobro.mockClear();
      await ctrl.createPayment(
        V332,
        dto({ factura_emitida_id: F0420 }),
        usuario(rol),
      );
      expect(dtoEnviado().factura_emitida_id).toBe(F0420);
    }
  });
});

describe('PATCH cobros/:cobroId con factura_emitida_id', () => {
  const parcial = (): Tablas => {
    const db = mundo({
      cobro_vuelo: [cobro('c-68208', 68208), cobro('c-977', 977.45)],
      movimiento_bancario: [
        {
          id: 'm1',
          cuenta_bancaria_id: CTA,
          fecha: '2026-09-22',
          tipo: 'ABONO',
          monto: 60000,
          conciliado: true,
          gasto_id: null,
          cobro_id: 'c-68208',
          cobro_grupo_id: null,
          clasificacion_id: null,
          notas: null,
          created_at: '2026-09-22T15:00:00Z',
          cobros_n: 1,
        },
      ],
      movimiento_bancario_cobro: [
        {
          movimiento_id: 'm1',
          cobro_id: 'c-68208',
          monto_parte: 60000,
          created_at: '2026-09-22T16:00:00Z',
          created_by: null,
        },
      ],
    });
    return db;
  };

  it('conciliado PARCIAL + factura_emitida_id ⇒ 200 sin COBRO_CONCILIADO (no es dinero): el UPDATE solo lleva la liga', async () => {
    const { svc, db, log } = armar(parcial());
    const r = (await svc.updateCobro(
      'c-68208',
      { factura_emitida_id: F0420 },
      USER,
    )) as Row;
    expect(r.factura_emitida_id).toBe(F0420);
    expect(
      db.cobro_vuelo.find((c) => c.id === 'c-68208')?.factura_emitida_id,
    ).toBe(F0420);
    const upd = log.find(
      (o) => o.tabla === 'cobro_vuelo' && o.op === 'update',
    ) as { cuerpo?: Row };
    expect(Object.keys(upd.cuerpo ?? {}).sort()).toEqual([
      'factura_emitida_id',
      'updated_by',
    ]);
    // El dinero sigue congelado: cambiar el monto rebota como siempre.
    const dinero = await error(
      svc.updateCobro('c-68208', { monto: 70000 }, USER),
    );
    expect(dinero.code).toBe('COBRO_CONCILIADO');
  });

  it('PATCH `null` suelta la liga; `undefined` no la toca; sin sonda ⇒ 503 antes de escribir', async () => {
    const { svc, db } = armar(
      mundo({
        cobro_vuelo: [cobro('c-68208', 68208, { factura_emitida_id: F0420 })],
      }),
    );
    await svc.updateCobro('c-68208', { referencia: 'ref' }, USER);
    expect(db.cobro_vuelo[0].factura_emitida_id).toBe(F0420);
    await svc.updateCobro('c-68208', { factura_emitida_id: null }, USER);
    expect(db.cobro_vuelo[0].factura_emitida_id).toBeNull();
    const sin = armar(mundo(), { ausentes: SIN_SONDA });
    const r = await error(
      sin.svc.updateCobro('c-68208', { factura_emitida_id: F0420 }, USER),
    );
    expect(r.code).toBe('COBRO_FACTURA_NO_DISPONIBLE');
    expect(sin.log.filter((o) => o.op === 'update')).toEqual([]);
  });

  it('reembolso ⇒ 400 REEMBOLSO_SIN_FACTURA; cancelada ⇒ 409; de otro vuelo ⇒ 409 con folio', async () => {
    const { svc } = armar(
      mundo({ cobro_vuelo: [cobro('c-re', -500), cobro('c-ok', 1700)] }),
    );
    const re = await error(
      svc.updateCobro('c-re', { factura_emitida_id: F0420 }, USER),
    );
    expect(re.e).toBeInstanceOf(BadRequestException);
    expect(re.code).toBe('REEMBOLSO_SIN_FACTURA');
    expect(re.message).toBe('Un reembolso no se liga a una factura.');
    expect(
      (
        await error(
          svc.updateCobro('c-ok', { factura_emitida_id: FCANC }, USER),
        )
      ).code,
    ).toBe('FACTURA_NO_VIGENTE');
    const otro = await error(
      svc.updateCobro('c-ok', { factura_emitida_id: FOTRO }, USER),
    );
    expect(otro.code).toBe('FACTURA_NO_LIGADA_AL_VUELO');
    expect(otro.details).toEqual({
      factura_id: FOTRO,
      vuelo_id: V332,
      folio: 332,
    });
  });

  it('carrera en el UPDATE (23514 del trigger A) ⇒ 409 FACTURA_NO_LIGADA_AL_VUELO con folio, nunca 500', async () => {
    const { svc } = armar(mundo(), {
      antes: (op) =>
        op.tabla === 'cobro_vuelo' && op.op === 'update'
          ? {
              code: '23514',
              message: 'FACTURA_NO_LIGADA_AL_VUELO: …',
              hint: 'FACTURA_NO_LIGADA_AL_VUELO',
              details: JSON.stringify({ factura_id: F0420, vuelo_id: V332 }),
            }
          : undefined,
    });
    const r = await error(
      svc.updateCobro('c-977', { factura_emitida_id: F0420 }, USER),
    );
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('FACTURA_NO_LIGADA_AL_VUELO');
    expect(r.message).toContain('#332');
    expect(r.details).toEqual({
      factura_id: F0420,
      vuelo_id: V332,
      folio: 332,
    });
  });
});

describe('listCobros / adjuntarSobres — factura_emitida {id, etiqueta}', () => {
  it('con la sonda: amparado ⇒ {id, etiqueta}; sin factura ⇒ null; cancelada ⇒ null; cero consultas a factura_emitida si ningún cobro trae id', async () => {
    const { svc, log } = armar(
      mundo({
        cobro_vuelo: [
          cobro('c-68208', 68208, { factura_emitida_id: F0420 }),
          cobro('c-977', 977.45),
          cobro('c-canc', 1700, { factura_emitida_id: FCANC }),
        ],
      }),
    );
    const lista = (await svc.listCobros(V332)) as Row[];
    const porId = new Map(lista.map((c) => [c.id, c]));
    expect(porId.get('c-68208')?.factura_emitida).toEqual({
      id: F0420,
      etiqueta: 'A-0420',
    });
    expect(porId.get('c-977')?.factura_emitida).toBeNull();
    expect(porId.get('c-canc')?.factura_emitida).toBeNull();
    expect(
      log.filter((o) => o.tabla === 'factura_emitida' && o.op === 'select'),
    ).toHaveLength(1);
    const limpio = armar(mundo());
    await limpio.svc.listCobros(V332);
    expect(limpio.log.filter((o) => o.tabla === 'factura_emitida')).toEqual([]);
  });

  it('la llave se OMITE para roles de campo (PILOTO) y sin la sonda', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c-68208', 68208, { factura_emitida_id: F0420 })],
    });
    const { svc } = armar(db);
    const piloto = (await svc.listCobros(V332, {
      userId: 'p',
      rol: Rol.PILOTO,
    } as unknown as AuthenticatedUser)) as Row[];
    expect('factura_emitida' in piloto[0]).toBe(false);
    // Sin la sonda la BD vieja ni tiene la columna (la fila nace sin ella).
    const viejo = cobro('c-68208', 68208);
    delete viejo.factura_emitida_id;
    const sin = armar(mundo({ cobro_vuelo: [viejo] }), { ausentes: SIN_SONDA });
    const lista = (await sin.svc.listCobros(V332)) as Row[];
    expect('factura_emitida' in lista[0]).toBe(false);
    expect('factura_emitida_id' in lista[0]).toBe(false);
  });

  it('250 cobros con 250 facturas distintas ⇒ las etiquetas se leen en 2 consultas (≤ 200 ids por .in)', async () => {
    const facturas = Array.from({ length: 250 }, (_, i) =>
      factura(`f-${i}`, String(1000 + i)),
    );
    const cobros = facturas.map((f, i) =>
      cobro(`c-${i}`, 100, { factura_emitida_id: f.id as string }),
    );
    const { svc, log } = armar(
      mundo({ factura_emitida: facturas, cobro_vuelo: cobros }),
    );
    const lista = (await svc.listCobros(V332)) as Row[];
    expect(lista).toHaveLength(250);
    expect(
      lista.every((c) =>
        (c.factura_emitida as { etiqueta: string }).etiqueta.startsWith('A-1'),
      ),
    ).toBe(true);
    expect(
      log.filter((o) => o.tabla === 'factura_emitida' && o.op === 'select'),
    ).toHaveLength(2);
  });
});

describe('cobroCols(disponible): los 7 selects de cobro_vuelo pasan por la fábrica', () => {
  it('0 `.select(COBRO_COLS)` y 7 `.select(cobroCols(` en flights.service.ts', () => {
    const fuente = readFileSync(join(__dirname, 'flights.service.ts'), 'utf8');
    expect(fuente.match(/\.select\(COBRO_COLS\)/g) ?? []).toHaveLength(0);
    expect(fuente.match(/\.select\(cobroCols\(/g)).toHaveLength(7);
  });
});
