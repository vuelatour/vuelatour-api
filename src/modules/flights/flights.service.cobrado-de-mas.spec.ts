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

import { Logger } from '@nestjs/common';
import { FlightsService } from './flights.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import { cobroEnUsd } from '../../common/cobros-usd.util';
import {
  fakeCobrosParciales,
  type OpcionesCobrosParciales,
  type Row,
  type Tablas,
} from '../conciliacion/cobros-parciales.fixture-spec';
import {
  CLIENTE_BEH_KAY,
  CLIENTES_REALES,
  COBRO_332_977,
  COBROS_315_ANTES,
  cobrosDe,
  VUELOS_REALES,
} from '../../common/cobrado-de-mas.fixture-spec';

/**
 * «COBRADO DE MÁS» EN EL SNAPSHOT DEL VUELO (14-oct-2026, API 0.0.78,
 * invariante 77, D13 y D21) con los datos REALES de prod:
 * - `cobrado_de_mas` con la regla pura y las fuentes únicas (#217 ⇒ IVA que
 *   la cotización no lleva), con lo cobrado IGUAL a `total_cobrado`;
 * - el #315 de ANTES de la corrección: la lectura best-effort de los cobros
 *   SIN BANCO de otros vuelos VIVOS del cliente encuentra el $977.45 del
 *   #332 ⇒ OTRO_VUELO_DEL_CLIENTE; con esa liga ya hecha, o con la lectura
 *   caída, SIN_CAUSA_CLARA y nunca un 5xx;
 * - la llave se OMITE para PILOTO/MECANICO/VISITANTE (ni se calcula);
 * - `cobros[i].monto_usd` con la MISMA cadena de T.C. que `total_cobrado`.
 */
const CTA = 'cta-scotia-pesos';

const PILOTO = { userId: 'u-p', rol: Rol.PILOTO } as AuthenticatedUser;
const MECANICO = { userId: 'u-m', rol: Rol.MECANICO } as AuthenticatedUser;
const VISITANTE = { userId: 'u-v', rol: Rol.VISITANTE } as AuthenticatedUser;
const ADMIN = { userId: 'u-a', rol: Rol.ADMIN } as AuthenticatedUser;
const SOCIO = { userId: 'u-s', rol: Rol.SOCIO } as AuthenticatedUser;

const copia = (filas: Row[]): Row[] => filas.map((f) => ({ ...f }));

/** Un abono del banco que ya paga `cobroId` (UNA parte, puente + espejo). */
function abonoLigado(
  db: Tablas,
  movId: string,
  cobroId: string,
  monto: number,
) {
  db.movimiento_bancario.push({
    id: movId,
    cuenta_bancaria_id: CTA,
    fecha: '2026-09-15',
    tipo: 'ABONO',
    monto,
    conciliado: true,
    gasto_id: null,
    cobro_id: cobroId,
    cobro_grupo_id: null,
    clasificacion_id: null,
    notas: null,
    created_at: '2026-09-16T15:00:00Z',
    cobros_n: 1,
  });
  db.movimiento_bancario_cobro.push({
    movimiento_id: movId,
    cobro_id: cobroId,
    monto_parte: monto,
    created_at: '2026-09-16T15:00:00Z',
    created_by: null,
  });
}

/** BD con los vuelos de Beh Kay y #217, los clientes y los cobros pedidos. */
function mundo(cobros: Row[]): Tablas {
  return {
    vuelo: [
      { ...VUELOS_REALES[217] },
      { ...VUELOS_REALES[315] },
      { ...VUELOS_REALES[332] },
    ],
    cliente: copia(CLIENTES_REALES),
    cobro_vuelo: copia(cobros),
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'Scotiabank Pesos',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
    ],
    cobro_grupo: [],
    vuelo_grupo: [],
    movimiento_bancario: [],
    movimiento_bancario_cobro: [],
  };
}

/**
 * El #315 ANTES de la corrección: sus dos cobros (69,183 y 3,400) y los del
 * #332 con sus abonos, MENOS el de $977.45 (que seguía sin banco).
 */
function beh315Antes(): Tablas {
  const db = mundo([
    ...COBROS_315_ANTES,
    ...cobrosDe(332).map((c) => ({ ...c })),
  ]);
  abonoLigado(db, 'mov-332-a', '15d97e3a-6256-4ae2-97ea-1479e9f419f5', 1700);
  abonoLigado(db, 'mov-332-b', '4e938868-7aa9-4e26-8a06-ded566ae092a', 68208);
  abonoLigado(db, 'mov-332-c', '6f2e65dd-1bf8-4c1f-81e5-d2601dd5c842', 1700);
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
  return { svc, log: f.log };
}

type Snap = Record<string, unknown> & {
  cobros: Array<Record<string, unknown>>;
};

/** ¿Se leyeron los vuelos del cliente (la lectura de «otro vuelo»)? */
const leyoOtrosVuelos = (log: ReturnType<typeof armar>['log']) =>
  log.some((o) => o.tabla === 'vuelo' && o.sel === 'id, folio');

const ID = (folio: number) => VUELOS_REALES[folio].id as string;

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('snapshot — cobrado_de_mas (invariante 77, D13)', () => {
  it('#217 (ADMIN): IVA que la cotización no lleva, con lo cobrado = total_cobrado y SIN leer otros vuelos', async () => {
    const { svc, log } = armar(mundo(cobrosDe(217)));
    const snap = (await svc.snapshot(ID(217), ADMIN)) as Snap;
    expect(snap.total_cobrado).toBe(3595.99);
    expect(snap.cobrado_de_mas).toMatchObject({
      causa: 'IVA_NO_COTIZADO',
      excedente_usd: 495.99,
      cobrado_usd: 3595.99,
      total_usd: 3100,
      requiere_revision: true,
      tono: 'AVISO',
      titulo: 'Cobrado de más: $495.99 USD',
      referencia: null,
      sin_tc: null,
    });
    expect(leyoOtrosVuelos(log)).toBe(false);
    // La llave va junto a los demás totales de cobro.
    const llaves = Object.keys(snap);
    expect(llaves.indexOf('cobrado_de_mas')).toBe(
      llaves.indexOf('cobros_sin_tc_mxn') + 1,
    );
  });

  it('#315 ANTES de la corrección: el $977.45 sin banco del #332 ⇒ OTRO_VUELO_DEL_CLIENTE con la referencia', async () => {
    const db = beh315Antes();
    // Un vuelo CANCELADO del mismo cliente con un cobro igual NO cuenta (si
    // contara, habría dos candidatos y no se diría ninguno).
    db.vuelo.push({
      ...VUELOS_REALES[332],
      id: 'v-cancelado',
      folio: 990,
      estado: 'CANCELADO',
    });
    db.cobro_vuelo.push({
      ...cobrosDe(332)[0],
      id: 'c-cancelado-977',
      vuelo_id: 'v-cancelado',
    });
    const { svc, log } = armar(db);
    const snap = (await svc.snapshot(ID(315), ADMIN)) as Snap;
    expect(snap.total_cobrado).toBe(4232.24);
    expect(snap.cobrado_de_mas).toMatchObject({
      causa: 'OTRO_VUELO_DEL_CLIENTE',
      excedente_usd: 56.99,
      requiere_revision: true,
      explicacion:
        'Lo cobrado ($4,232.24 USD) rebasa el monto total ($4,175.25 USD). Posible causa: el cobro de $977.45 MXN del vuelo #332 del mismo cliente sigue sin banco y equivale a lo cobrado de más: puede que un cobro de este vuelo incluya el pago de ese vuelo.',
      referencia: {
        vuelo_id: ID(332),
        folio: 332,
        cobro_id: COBRO_332_977,
        monto: 977.45,
        moneda: 'MXN',
      },
    });
    expect(leyoOtrosVuelos(log)).toBe(true);
    // Los cobros de esos vuelos con su propio select (sin la migración de
    // ingresos no nombra `ingreso_anticipo_id`).
    expect(
      log.some(
        (o) =>
          o.tabla === 'cobro_vuelo' &&
          o.sel ===
            'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, cobro_grupo_id',
      ),
    ).toBe(true);
  });

  it('#315 ANTES pero con el $977.45 YA ligado a un abono ⇒ no es «sin banco»: SIN_CAUSA_CLARA', async () => {
    const db = beh315Antes();
    abonoLigado(db, 'mov-332-977', COBRO_332_977, 977.45);
    const { svc } = armar(db);
    const snap = (await svc.snapshot(ID(315), ADMIN)) as Snap;
    expect(snap.cobrado_de_mas).toMatchObject({
      causa: 'SIN_CAUSA_CLARA',
      excedente_usd: 56.99,
      referencia: null,
      explicacion:
        'Lo cobrado ($4,232.24 USD) rebasa el monto total ($4,175.25 USD) y no se ve una causa clara.',
    });
  });

  it('con la migración de ingresos: el select nombra ingreso_anticipo_id y un cobro salido de un ANTICIPO no cuenta como «sin banco»', async () => {
    const libre = beh315Antes();
    const { svc: svcLibre, log } = armar(libre, { ausentes: [] });
    const snapLibre = (await svcLibre.snapshot(ID(315), ADMIN)) as Snap;
    expect(snapLibre.cobrado_de_mas).toMatchObject({
      causa: 'OTRO_VUELO_DEL_CLIENTE',
    });
    expect(
      log.some(
        (o) =>
          o.tabla === 'cobro_vuelo' &&
          o.sel ===
            'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, cobro_grupo_id, ingreso_anticipo_id',
      ),
    ).toBe(true);
    const deAnticipo = beh315Antes();
    deAnticipo.cobro_vuelo = deAnticipo.cobro_vuelo.map((c) =>
      c.id === COBRO_332_977 ? { ...c, ingreso_anticipo_id: 'ing-12' } : c,
    );
    const { svc } = armar(deAnticipo, { ausentes: [] });
    const snap = (await svc.snapshot(ID(315), ADMIN)) as Snap;
    expect(snap.cobrado_de_mas).toMatchObject({ causa: 'SIN_CAUSA_CLARA' });
  });

  it('lectura de otros vuelos CAÍDA ⇒ SIN_CAUSA_CLARA y warn, nunca 5xx', async () => {
    const { svc } = armar(beh315Antes(), {
      antes: (op) =>
        op.tabla === 'vuelo' && op.sel === 'id, folio'
          ? {
              code: '57014',
              message: 'canceling statement due to statement timeout',
            }
          : undefined,
    });
    const snap = (await svc.snapshot(ID(315), ADMIN)) as Snap;
    expect(snap.cobrado_de_mas).toMatchObject({ causa: 'SIN_CAUSA_CLARA' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `cobrado de más: no se pudieron leer los cobros de otros vuelos del cliente ${CLIENTE_BEH_KAY}`,
      ),
    );
  });

  it('#217 con la lectura de la FILA DE PRECIOS caída ⇒ la llave se OMITE (no se pudo verificar ≠ «sin excedente», revisión del 15-oct-2026) y queda un warn', async () => {
    const { svc } = armar(mundo(cobrosDe(217)), {
      antes: (op) =>
        op.tabla === 'vuelo' && op.sel.startsWith('calculo_snapshot')
          ? {
              code: '57014',
              message: 'canceling statement due to statement timeout',
            }
          : undefined,
    });
    const snap = (await svc.snapshot(ID(217), ADMIN)) as Snap;
    expect(snap).not.toHaveProperty('cobrado_de_mas');
    // Lo demás del snapshot sigue (el total cobrado sale de los cobros).
    expect(snap.total_cobrado).toBe(3595.99);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `Snapshot del vuelo ${ID(217)}: no se pudo leer la fila de precios`,
      ),
    );
  });

  it('#315 de HOY (corregido) ⇒ cobrado_de_mas null (la llave viaja para oficina) y sin lecturas extra', async () => {
    const { svc, log } = armar(mundo(cobrosDe(315)));
    const snap = (await svc.snapshot(ID(315), SOCIO)) as Snap;
    expect(snap).toHaveProperty('cobrado_de_mas', null);
    expect(snap.total_cobrado).toBe(4175.25);
    expect(leyoOtrosVuelos(log)).toBe(false);
  });

  it.each([
    ['PILOTO', PILOTO],
    ['MECANICO', MECANICO],
    ['VISITANTE', VISITANTE],
  ])(
    '%s: la llave se OMITE (ni se calcula ni lee otros vuelos); monto_usd sí viaja',
    async (_rol, user) => {
      const { svc, log } = armar(beh315Antes());
      const snap = (await svc.snapshot(ID(315), user)) as Snap;
      expect(snap).not.toHaveProperty('cobrado_de_mas');
      expect(leyoOtrosVuelos(log)).toBe(false);
      expect(snap.cobros.map((c) => c.monto_usd)).toEqual(
        expect.arrayContaining([4033.99, 198.25]),
      );
    },
  );
});

describe('snapshot — cobros[i].monto_usd con la MISMA cadena de T.C. que total_cobrado (D21)', () => {
  it('cada cobro con cobroEnUsd(c, T.C. del vuelo); la suma cuadra con total_cobrado', async () => {
    const cobros = [
      ...cobrosDe(217),
      // Sin T.C. propio: toma el del vuelo (16.959955).
      {
        ...cobrosDe(217)[0],
        id: 'c-sin-tc-propio',
        monto: '5000.00',
        tc_usd_mxn: null,
        fecha_cobro: '2026-08-29T17:00:00+00:00',
      },
    ];
    const { svc } = armar(mundo(cobros));
    const snap = (await svc.snapshot(ID(217), ADMIN)) as Snap;
    const porId = new Map(snap.cobros.map((c) => [c.id, c.monto_usd]));
    expect(porId.get('8da8501d-5b75-4d03-8e25-eca232a06085')).toBe(3595.99);
    expect(porId.get('c-sin-tc-propio')).toBe(
      cobroEnUsd({ monto: 5000, moneda: 'MXN' }, 16.959955),
    );
    expect(porId.get('c-sin-tc-propio')).toBe(294.81);
    const suma = snap.cobros.reduce((a, c) => a + Number(c.monto_usd), 0);
    expect(Math.round(suma * 100) / 100).toBe(snap.total_cobrado);
  });

  it('vuelo sin T.C. y un cobro en pesos sin T.C. ⇒ monto_usd null, cobros_sin_tc y sin_tc en el bloque', async () => {
    const db = mundo([
      ...cobrosDe(217),
      {
        ...cobrosDe(217)[0],
        id: 'c-sin-tc',
        monto: '5000.00',
        tc_usd_mxn: null,
      },
    ]);
    db.vuelo = db.vuelo.map((v) =>
      v.id === ID(217) ? { ...v, tc_usd_mxn: null } : v,
    );
    const { svc } = armar(db);
    const snap = (await svc.snapshot(ID(217), ADMIN)) as Snap;
    const sinTc = snap.cobros.find((c) => c.id === 'c-sin-tc')!;
    expect(sinTc.monto_usd).toBeNull();
    expect(snap).toMatchObject({
      total_cobrado: 3595.99,
      cobros_sin_tc_count: 1,
      cobros_sin_tc_mxn: 5000,
      cobrado_de_mas: {
        causa: 'IVA_NO_COTIZADO',
        excedente_usd: 495.99,
        sin_tc: { n: 1, mxn: 5000 },
      },
    });
  });

  it('el snapshot no cambia los cobros de listCobros salvo por monto_usd (aditivo)', async () => {
    const { svc } = armar(mundo(cobrosDe(217)));
    const snap = (await svc.snapshot(ID(217), ADMIN)) as Snap;
    const lista = await svc.listCobros(ID(217), ADMIN);
    expect(lista[0]).not.toHaveProperty('monto_usd');
    const { monto_usd: _m, ...resto } = snap.cobros[0];
    void _m;
    expect(resto).toEqual(lista[0]);
  });
});
