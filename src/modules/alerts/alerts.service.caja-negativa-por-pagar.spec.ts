// La alerta diaria «Caja chica en NEGATIVO» y gastos «por pagar»
// (19-oct-2026, invariante 93; revisión P13). Dependencias pesadas fuera.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));
// La ubicación en el balance del detalle del fondo no es de este spec.
jest.mock('../../common/afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/afac-real-disponible.util',
  ),
  afacRealDisponible: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

import { Logger } from '@nestjs/common';
import { AlertsService, type AlertConfig } from './alerts.service';
import { CajaChicaService } from '../caja-chica/caja-chica.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * El contrato (§5) dice que un EFECTIVO por pagar vigente NO es del libro de
 * caja chica; la alerta diaria `caja_negativa` seguía restándolo y avisaba un
 * sobregiro que no existe en ningún libro (saldo 200 en pantalla − TAXI de
 * 500 por pagar ⇒ «Saldo -300.00 MXN»). Hoy la alerta usa la MISMA regla
 * (`efectivoQueCuentaEnCaja`) que el detalle, la lista de fondos y «Mi caja»:
 * el saldo de la alerta = el de la pantalla, siempre.
 *
 * Reloj: lunes 19-oct-2026 10:00 Cancún.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;
interface Consulta {
  tabla: string;
  sel: string;
}

const USER = 'u-pablo';
const FONDO = 'f-pablo';
const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Supabase falso por tabla (eq/in/is/gte/lte/order/limit) + la sonda. */
function fakeSupabase(db: Tablas, opts: { sinPorPagar?: boolean } = {}) {
  const log: Consulta[] = [];
  const service = {
    from(tabla: string) {
      const q: Consulta = { tabla, sel: '' };
      log.push(q);
      const filtros: Array<(r: Row) => boolean> = [];
      let tope: number | null = null;
      const ejecutar = (unico: boolean) => {
        if (
          opts.sinPorPagar &&
          tabla === 'gasto' &&
          /\bpor_pagar\b/.test(q.sel)
        ) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column gasto.por_pagar does not exist',
            },
          };
        }
        let filas = (db[tabla] ?? []).filter((r) => filtros.every((f) => f(r)));
        if (tope != null) filas = filas.slice(0, tope);
        return { data: unico ? (filas[0] ?? null) : filas, error: null };
      };
      const api: Record<string, unknown> = {
        select(s: string) {
          q.sel = s;
          return api;
        },
        eq(col: string, val: unknown) {
          filtros.push((r) => r[col] === val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        is(col: string, val: unknown) {
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        gte(col: string, val: string) {
          filtros.push((r) => texto(r[col]) >= val);
          return api;
        },
        lte(col: string, val: string) {
          filtros.push((r) => texto(r[col]) <= val);
          return api;
        },
        order: () => api,
        range: () => api,
        limit(n: number) {
          tope = n;
          return api;
        },
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

const gasto = (id: string, extra: Row = {}): Row => ({
  id,
  monto: 500,
  moneda: 'MXN',
  fecha_gasto: '2026-10-14',
  categoria: 'TAXI',
  lugar: 'CUN',
  notas: null,
  vuelo_id: null,
  escala_id: null,
  aeronave_id: null,
  inventario_movimiento_id: null,
  medio_pago: 'EFECTIVO',
  usuario_captura_id: USER,
  created_at: '2026-10-14T18:00:00+00:00',
  vuelo: null,
  escala: null,
  por_pagar: false,
  conciliado: false,
  ...extra,
});

/**
 * Fondo CLÁSICO de $1,000 con $800 gastados (saldo $200 en pantalla) + un
 * TAXI EFECTIVO de $500 capturado con fecha de mañana (por pagar).
 */
function mundo(taxi: Row = {}): Tablas {
  return {
    caja_chica_fondo: [
      {
        id: FONDO,
        usuario_id: USER,
        moneda: 'MXN',
        activo: true,
        es_acumulada: false,
        monto_fondo: 1000,
        created_at: '2026-09-01T15:00:00+00:00',
        usuario: { nombre: 'Pablo Canales', email: 'p@x.mx', rol: 'PILOTO' },
      },
    ],
    caja_chica_movimiento: [
      {
        id: 'm-repo',
        fondo_id: FONDO,
        tipo: 'REPOSICION',
        monto: '1000.00',
        moneda: 'MXN',
        fecha: '2026-10-01',
        autorizado_por: null,
        referencia: null,
        notas: 'Fondo octubre',
        registrado_por: null,
        espejo_de_id: null,
        created_at: '2026-10-01T15:00:00+00:00',
        autorizado: null,
        registrado: null,
      },
    ],
    aeronave: [],
    escala: [],
    gasto_reparto: [],
    gasto: [
      gasto('g-comida', { categoria: 'COMIDA', monto: 800 }),
      gasto('g-taxi', {
        fecha_gasto: '2026-10-20',
        por_pagar: true,
        created_at: '2026-10-19T14:00:00+00:00',
        ...taxi,
      }),
    ],
  };
}

const config: AlertConfig = {
  clave: 'caja_negativa',
  descripcion: 'x',
  activa: true,
  canal: 'socket',
  roles: ['ADMIN', 'FACTURACION'],
  dias_anticipacion: [],
  horas_anticipacion: null,
};

type Priv = Record<string, (c: AlertConfig) => Promise<void>>;

/** La alerta y los tres lectores de caja chica sobre el MISMO mundo. */
async function correr(db: Tablas, opts: { sinPorPagar?: boolean } = {}) {
  const f = fakeSupabase(db, opts);
  const alerts = new AlertsService(
    f.supabase,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const dispatch = jest.fn().mockResolvedValue(undefined);
  Object.assign(alerts as unknown as Record<string, unknown>, { dispatch });
  await (alerts as unknown as Priv).checkCajaNegativa(config);
  // Lectores de caja chica con OTRO cliente (cada uno sondea por su cuenta).
  const caja = new CajaChicaService(fakeSupabase(db, opts).supabase);
  const lista = (await caja.listFondos({
    limit: 50,
    offset: 0,
  })) as unknown as { data: Array<{ saldo: number }> };
  const detalle = (await caja.getFondoDetail(FONDO)) as unknown as {
    saldo: number;
  };
  const miCaja = (await caja.getMyFondo(USER)) as unknown as { saldo: number };
  return {
    dispatch,
    log: f.log,
    saldos: {
      lista: lista.data[0]?.saldo,
      detalle: detalle.saldo,
      mi_caja: miCaja.saldo,
    },
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
beforeEach(() =>
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate'],
    now: new Date('2026-10-19T15:00:00Z'),
  }),
);
afterEach(() => jest.useRealTimers());

describe('AlertsService.checkCajaNegativa — gastos por pagar fuera (P13)', () => {
  it('saldo $200 en pantalla + TAXI de $500 POR PAGAR ⇒ la alerta NO dispara (antes: «Saldo -300.00»)', async () => {
    const { dispatch, saldos } = await correr(mundo());
    expect(dispatch).not.toHaveBeenCalled();
    expect(saldos).toEqual({ lista: 200, detalle: 200, mi_caja: 200 });
  });

  it('un por pagar VENCIDO tampoco cuenta (sigue sin salir de la caja)', async () => {
    const { dispatch } = await correr(mundo({ fecha_gasto: '2026-10-16' }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('MARCADO PAGADO: entra a la caja y la alerta dispara con el MISMO saldo que el panel y la app', async () => {
    const { dispatch, saldos } = await correr(
      mundo({ por_pagar: false, fecha_gasto: '2026-10-19' }),
    );
    expect(saldos).toEqual({ lista: -300, detalle: -300, mi_caja: -300 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      config,
      `caja:${FONDO}:2026-10-19`,
      expect.objectContaining({
        titulo: 'Caja chica en NEGATIVO: Pablo Canales',
        cuerpo:
          'Saldo -300.00 MXN. Registra la reposición o revisa los gastos en efectivo.',
        data: { fondo_id: FONDO, saldo: -300 },
      }),
    );
  });

  it('CONCILIADO con el banco ⇒ PAGADO aunque la columna diga true: cuenta', async () => {
    const { dispatch, saldos } = await correr(mundo({ conciliado: true }));
    expect(saldos.lista).toBe(-300);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('SIN la migración: la conducta del 0.0.94 (todo efectivo cuenta) y solo la sonda nombra `por_pagar`', async () => {
    const { dispatch, log } = await correr(mundo(), { sinPorPagar: true });
    expect(dispatch).toHaveBeenCalledWith(
      config,
      `caja:${FONDO}:2026-10-19`,
      expect.objectContaining({ data: { fondo_id: FONDO, saldo: -300 } }),
    );
    const nombran = log.filter(
      (q) => q.tabla === 'gasto' && /\bpor_pagar\b/.test(q.sel),
    );
    expect(nombran.map((q) => q.sel)).toEqual(['por_pagar']);
  });
});
