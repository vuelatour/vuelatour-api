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

import { ConflictException } from '@nestjs/common';
import { FlightsService } from './flights.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';
import {
  fakeCobrosParciales,
  type OpcionesCobrosParciales,
  type Row,
  type Tablas,
} from '../conciliacion/cobros-parciales.fixture-spec';

/**
 * UN COBRO, VARIOS ABONOS — EL CANDADO DEL DINERO DEL COBRO (14-oct-2026,
 * API 0.0.78, invariante 77; trigger E en la BD). Se congela:
 * - el 409 COBRO_CONCILIADO ESTRUCTURADO de PATCH/DELETE flights/cobros/:id
 *   ({cobro_id, estado, movimientos_ligados, parcial, faltante}) con el
 *   texto de cada caso (parcial, 2 abonos, 1 abono, sobre);
 * - `updateCobro` decide con el valor NUEVO contra el VIGENTE
 *   (`cambiaDineroDelCobro`): el formulario completo reenviado SIN cambio de
 *   dinero con abonos se CONGELA y guarda la referencia (sin mover un
 *   centavo la comisión contra el trigger E); sin abonos, como siempre;
 * - la carrera: el 23514 COBRO_CONCILIADO del trigger E (UPDATE) y el 23503
 *   de la FK RESTRICT de la puente (DELETE) ⇒ el MISMO 409, nunca 500.
 */
const USER = 'u-oficina';
const V315 = 'v315';
const CTA = 'cta-mxn';

const cobro = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  vuelo_id: V315,
  monto,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  tc_usd_mxn: 17.15,
  comision_banco_pct: null,
  comision_banco_monto: null,
  cuenta_destino: null,
  referencia: null,
  fecha_cobro: '2026-09-15T17:00:00Z',
  foto_voucher_url: null,
  registrado_por: null,
  notas: null,
  created_at: '2026-09-15T17:00:00Z',
  updated_at: '2026-09-15T17:00:00Z',
  cobro_grupo_id: null,
  grupo_factor: null,
  ...extra,
});

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-15',
  tipo: 'ABONO',
  monto,
  conciliado: true,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  notas: null,
  created_at: '2026-09-16T15:00:00Z',
  cobros_n: 1,
  ...extra,
});

/** El cobro c315 con los abonos dados (cada uno de UN cobro). */
function mundo(
  abonos: Array<[string, number, string]>,
  extra: Partial<Tablas> = {},
): Tablas {
  const db: Tablas = {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'EJE SCOTIA',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
    ],
    vuelo: [{ id: V315, folio: 315, cliente_id: null, tc_usd_mxn: 17.15 }],
    cobro_vuelo: [cobro('c315', 3400)],
    cobro_grupo: [],
    vuelo_grupo: [],
    movimiento_bancario: [],
    movimiento_bancario_cobro: [],
    ...extra,
  };
  for (const [id, monto, fecha] of abonos) {
    db.movimiento_bancario.push(abono(id, monto, { fecha, cobro_id: 'c315' }));
    db.movimiento_bancario_cobro.push({
      movimiento_id: id,
      cobro_id: 'c315',
      monto_parte: monto,
      created_at: `${fecha}T16:00:00Z`,
      created_by: null,
    });
  }
  return db;
}

function armar(db: Tablas, opts: OpcionesCobrosParciales = {}) {
  const f = fakeCobrosParciales(db, opts);
  const svc = new FlightsService(
    f.supabase,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  // La bandera `cobrado` lee el vuelo completo: fuera de este spec.
  const refresh = jest
    .spyOn(svc, 'refreshCobradoFlag')
    .mockResolvedValue({ antes: false, despues: false });
  return { svc, db, log: f.log, escrituras: f.escrituras, refresh };
}

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

describe('Candado del dinero de un cobro con abonos — 409 COBRO_CONCILIADO estructurado', () => {
  it('PARCIAL (1,700 de 3,400): PATCH del monto ⇒ 409 con el texto del parcial y los abonos ligados, sin escribir', async () => {
    const { svc, db, escrituras } = armar(mundo([['m1', 1700, '2026-09-15']]));
    const r = await error(svc.updateCobro('c315', { monto: 3000 }, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('COBRO_CONCILIADO');
    expect(r.message).toBe(
      'Este cobro está conciliado PARCIAL con el banco ($1,700.00 MXN de $3,400.00 MXN, abono del 15 sep). Para cambiar su monto, moneda, tipo de cambio o comisión, o para eliminarlo, primero desvincula ese abono en Conciliación.',
    );
    expect(r.details).toEqual({
      cobro_id: 'c315',
      estado: 'PARCIAL',
      movimientos_ligados: [
        {
          movimiento_id: 'm1',
          fecha: '2026-09-15',
          monto_parte: 1700,
          cuenta: 'EJE SCOTIA',
        },
      ],
      parcial: true,
      faltante: 1700,
    });
    expect(escrituras()).toEqual([]);
    expect(db.cobro_vuelo[0].monto).toBe(3400);
  });

  it('2 abonos (cubierto): DELETE ⇒ 409 con los dos abonos; 1 abono ⇒ el texto de siempre', async () => {
    const dos = armar(
      mundo([
        ['m1', 1700, '2026-09-15'],
        ['m2', 1700, '2026-09-15'],
      ]),
    );
    const r = await error(dos.svc.deleteCobro('c315', USER));
    expect(r.code).toBe('COBRO_CONCILIADO');
    expect(r.message).toBe(
      'Este cobro está conciliado con 2 abonos del banco (15 sep · $1,700.00 y 15 sep · $1,700.00). Para cambiar su dinero o eliminarlo, primero desvincula esos abonos en Conciliación.',
    );
    expect(r.details).toMatchObject({
      estado: 'CONCILIADO',
      parcial: false,
      faltante: 0,
    });
    expect(dos.escrituras()).toEqual([]);
    expect(dos.db.cobro_vuelo).toHaveLength(1);
    const uno = armar(mundo([['m1', 3400, '2026-09-15']]));
    const r1 = await error(
      uno.svc.updateCobro('c315', { moneda: 'USD' as never }, USER),
    );
    expect(r1.code).toBe('COBRO_CONCILIADO');
    expect(r1.message).toBe(
      'Este cobro está conciliado con un movimiento bancario. Desvincúlalo primero en Conciliación.',
    );
  });

  it('parte de un SOBRE ligado ⇒ el texto del sobre (por COBRO_DE_GRUPO no llega: es el candado del sobre)', async () => {
    const db = mundo([], {
      cobro_vuelo: [cobro('c315', 3400, { cobro_grupo_id: 's12' })],
      cobro_grupo: [{ id: 's12', grupo_id: 'g12', monto: 3400, moneda: 'MXN' }],
      vuelo_grupo: [{ id: 'g12', folio: 12 }],
    });
    db.movimiento_bancario.push(
      abono('mS', 3400, { cobro_grupo_id: 's12', cobros_n: 0 }),
    );
    const { svc } = armar(db);
    // Una parte de sobre se corrige desde el grupo (409 COBRO_DE_GRUPO de
    // siempre); el candado del sobre se prueba directo.
    const conflicto = await (
      svc as unknown as {
        conflictoCobroConciliado: (c: Row) => Promise<ConflictException | null>;
      }
    ).conflictoCobroConciliado({
      id: 'c315',
      cobro_grupo_id: 's12',
      monto: 3400,
      moneda: 'MXN',
    });
    const resp = conflicto?.getResponse() as {
      message?: string;
      details?: Row;
      error?: string;
    };
    expect(resp.error).toBe('COBRO_CONCILIADO');
    expect(resp.message).toBe(
      'Este cobro es parte de un sobre de grupo conciliado con un movimiento bancario. Desvincula el sobre primero en Conciliación.',
    );
    expect(resp.details).toMatchObject({
      estado: 'CONCILIADO',
      via: 'SOBRE',
      movimientos_ligados: [
        { movimiento_id: 'mS', monto_parte: 3400, cuenta: 'EJE SCOTIA' },
      ],
      parcial: false,
    });
  });
});

describe('updateCobro — valor NUEVO contra VIGENTE (cambiaDineroDelCobro) y la carrera con el trigger E', () => {
  it('formulario COMPLETO reenviado sin cambio de dinero con abonos ⇒ se CONGELA el dinero y se guarda la referencia', async () => {
    const db = mundo([['m1', 1700, '2026-09-15']]);
    db.cobro_vuelo[0] = cobro('c315', 3400, {
      comision_banco_monto: 301.12,
      comision_banco_pct: 8.8565,
    });
    const { svc, escrituras } = armar(db);
    const r = (await svc.updateCobro(
      'c315',
      {
        monto: 3400,
        moneda: 'MXN' as never,
        tc_usd_mxn: 17.15,
        comision_banco_pct: 8.8565,
        referencia: 'SPEI 0915',
      },
      USER,
    )) as Row;
    expect(r.referencia).toBe('SPEI 0915');
    const update = escrituras().find(
      (o) => o.tabla === 'cobro_vuelo' && o.op === 'update',
    )!;
    // Ni monto, ni moneda, ni T.C., ni comisión (recalcularla desde el % la
    // movería un centavo contra el trigger E: 3,400 × 8.8565 % = 301.121).
    expect(Object.keys(update.cuerpo ?? {}).sort()).toEqual([
      'referencia',
      'updated_by',
    ]);
    expect(db.cobro_vuelo[0]).toMatchObject({
      monto: 3400,
      comision_banco_monto: 301.12,
      referencia: 'SPEI 0915',
    });
  });

  it('sin abonos, como siempre: el monto cambia y la comisión se recalcula desde el %', async () => {
    const db = mundo([]);
    db.cobro_vuelo[0] = cobro('c315', 3400, {
      comision_banco_monto: 301.12,
      comision_banco_pct: 8.8565,
    });
    const { svc } = armar(db);
    await svc.updateCobro('c315', { monto: 4000 }, USER);
    expect(db.cobro_vuelo[0]).toMatchObject({
      monto: 4000,
      comision_banco_monto: 354.26,
    });
  });

  it('el T.C. también es dinero para el API (como el 0.0.77): con abonos, otro T.C. ⇒ 409; el mismo normalizado ⇒ pasa', async () => {
    const { svc } = armar(mundo([['m1', 1700, '2026-09-15']]));
    expect(
      (await error(svc.updateCobro('c315', { tc_usd_mxn: 18 }, USER))).code,
    ).toBe('COBRO_CONCILIADO');
    await expect(
      svc.updateCobro('c315', { tc_usd_mxn: 17.15, notas: 'ok' }, USER),
    ).resolves.toMatchObject({ notas: 'ok', tc_usd_mxn: 17.15 });
  });

  it('carrera: un abono se ligó entre el candado y el UPDATE ⇒ el 23514 COBRO_CONCILIADO del trigger E sale como el MISMO 409 (se relee la liga)', async () => {
    const db = mundo([]);
    db.movimiento_bancario.push(
      abono('mX', 1700, { cobro_id: null, cobros_n: 0, conciliado: false }),
    );
    let carrera = false;
    const { svc } = armar(db, {
      antes: (op, tablas) => {
        if (!carrera && op.tabla === 'cobro_vuelo' && op.op === 'update') {
          carrera = true;
          Object.assign(tablas.movimiento_bancario[0], {
            cobro_id: 'c315',
            cobros_n: 1,
            conciliado: true,
          });
          tablas.movimiento_bancario_cobro.push({
            movimiento_id: 'mX',
            cobro_id: 'c315',
            monto_parte: 1700,
            created_at: '2026-10-14T10:00:00Z',
            created_by: null,
          });
        }
        return undefined;
      },
    });
    const r = await error(svc.updateCobro('c315', { monto: 3000 }, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('COBRO_CONCILIADO');
    expect(r.details).toMatchObject({
      estado: 'PARCIAL',
      parcial: true,
      faltante: 1700,
    });
    expect(r.message).toContain('conciliado PARCIAL con el banco');
    expect(db.cobro_vuelo[0].monto).toBe(3400);
  });

  it('carrera sin poder releer la liga ⇒ el 409 genérico con los details de la BD (nunca 500)', async () => {
    const db = mundo([]);
    db.movimiento_bancario.push(
      abono('mX', 1700, { cobro_id: null, cobros_n: 0, conciliado: false }),
    );
    let carrera = false;
    let caida = false;
    const { svc } = armar(db, {
      antes: (op, tablas) => {
        if (!carrera && op.tabla === 'cobro_vuelo' && op.op === 'update') {
          carrera = true;
          caida = true;
          tablas.movimiento_bancario_cobro.push({
            movimiento_id: 'mX',
            cobro_id: 'c315',
            monto_parte: 1700,
            created_at: '2026-10-14T10:00:00Z',
            created_by: null,
          });
          return undefined;
        }
        if (
          caida &&
          op.tabla === 'movimiento_bancario_cobro' &&
          op.op === 'select'
        ) {
          return {
            code: '57014',
            message: 'canceling statement due to statement timeout',
          };
        }
        return undefined;
      },
    });
    const r = await error(svc.updateCobro('c315', { monto: 3000 }, USER));
    expect(r.code).toBe('COBRO_CONCILIADO');
    expect(r.message).toBe(
      'El cobro tiene abonos del banco vinculados: su monto, moneda, comisión, sobre o anticipo no cambian mientras esté conciliado; desvincúlalo en Conciliación primero.',
    );
    expect(r.details).toMatchObject({
      cobro_id: 'c315',
      abonos: 1,
      campos: ['monto'],
      movimiento_ids: ['mX'],
    });
  });
});

describe('deleteCobro — la FK RESTRICT de la puente en una carrera', () => {
  it('sin abonos se borra; con un abono ligado en carrera ⇒ 23503 ⇒ el MISMO 409 COBRO_CONCILIADO y nada se borra', async () => {
    const libre = armar(mundo([]));
    await expect(libre.svc.deleteCobro('c315', USER)).resolves.toEqual({
      ok: true,
    });
    expect(libre.db.cobro_vuelo).toEqual([]);
    const db = mundo([]);
    db.movimiento_bancario.push(
      abono('mX', 3400, { cobro_id: null, cobros_n: 0, conciliado: false }),
    );
    let carrera = false;
    const { svc } = armar(db, {
      antes: (op, tablas) => {
        if (!carrera && op.tabla === 'cobro_vuelo' && op.op === 'delete') {
          carrera = true;
          Object.assign(tablas.movimiento_bancario[0], {
            cobro_id: 'c315',
            cobros_n: 1,
            conciliado: true,
          });
          tablas.movimiento_bancario_cobro.push({
            movimiento_id: 'mX',
            cobro_id: 'c315',
            monto_parte: 3400,
            created_at: '2026-10-14T10:00:00Z',
            created_by: null,
          });
        }
        return undefined;
      },
    });
    const r = await error(svc.deleteCobro('c315', USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('COBRO_CONCILIADO');
    expect(r.message).toBe(
      'Este cobro está conciliado con un movimiento bancario. Desvincúlalo primero en Conciliación.',
    );
    expect(r.details).toMatchObject({
      estado: 'CONCILIADO',
      movimientos_ligados: [{ movimiento_id: 'mX' }],
    });
    expect(db.cobro_vuelo).toHaveLength(1);
  });
});
