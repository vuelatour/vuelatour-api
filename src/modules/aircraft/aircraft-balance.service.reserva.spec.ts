// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  fuenteTcLegible: (f: string | null | undefined) =>
    f === 'OPEN_ER_API' ? 'open.er-api' : (f ?? 'TC oficial'),
}));
// Sin la migración del cierre de mes (el eje de siempre).
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { BalanceAvionPayload } from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';
import {
  AV2,
  TC_OFICIAL_PESOS,
  fakeSupabaseReparto,
  mundoPesos,
} from '../profit-sharing/reparto-pesos.fixture-spec';

/**
 * RESERVA DE OVERHAUL MARCADA EN EL BALANCE (19-oct-2026, API 0.0.98,
 * invariante 96). Decisión del cliente: «que solo aparezca marcado lo que se
 * tiene que reservar en el balance general y del avión sin hacer descuento
 * de nada». El bloque `balance` trae la aportación del periodo —horas
 * voladas × Σ USD/hr de los motores, la MISMA cuenta del reparto (fuente
 * única `common/reserva-overhaul.util`)— y en pesos al T.C. oficial del
 * cierre; NINGUNA utilidad del balance la resta. El reparto sigue
 * restándola (sin cambio).
 *
 * Mundo: el del reparto en pesos (XB-TST con 3.5 h voladas y reserva de 40
 * USD/hr; T.C. oficial del 30-sep = 18.6; XB-DOS sin vuelos ni reserva).
 */

type General = {
  usd_por_gasto?: true;
  aviones: BalanceAvionPayload[];
};

function servicio(m: Record<string, Fila[]>) {
  const f = fakeSupabaseReparto(m);
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        enviados.individual = p;
        return Promise.resolve(Buffer.from('x'));
      },
      generateBalanceGeneralXlsx: (p: General) => {
        enviados.general = p;
        return Promise.resolve(Buffer.from('x'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    {
      oficialDetallePara: (dia: string) => {
        const tc = TC_OFICIAL_PESOS[dia];
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  return { service, enviados };
}

async function libro(
  m: Record<string, Fila[]> = mundoPesos(),
  avion: string = AV,
): Promise<BalanceAvionPayload> {
  const s = servicio(m);
  await s.service.xlsx(avion, DESDE, HASTA);
  return s.enviados.individual!;
}

async function general(m: Record<string, Fila[]> = mundoPesos()) {
  const s = servicio(m);
  await s.service.xlsxGeneral(DESDE, HASTA);
  return s.enviados.general!;
}

async function reparto(m: Record<string, Fila[]> = mundoPesos()) {
  const f = fakeSupabaseReparto(m);
  const svc = new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    {
      oficialDetallePara: (dia: string) => {
        const tc = TC_OFICIAL_PESOS[dia];
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    {} as never,
  );
  svc.ahora = () => new Date('2026-10-19T15:00:00Z');
  const r = await svc.compute({ desde: DESDE, hasta: HASTA });
  return r.aviones.find((a) => a.aeronave.id === AV)!;
}

const LLAVES_RESERVA = [
  'reserva_overhaul_usd',
  'reserva_overhaul_mxn',
  'reserva_overhaul_horas_hr',
  'reserva_overhaul_usd_hr',
  'reserva_overhaul_motores',
  'reserva_overhaul_tc',
  'reserva_overhaul_tc_dia',
  'reserva_overhaul_incompleta',
];

/** El bloque `balance` sin la reserva (todo lo demás debe quedar igual). */
function sinReserva(b: BalanceAvionPayload['balance']) {
  const c = { ...b } as Record<string, unknown>;
  for (const k of LLAVES_RESERVA) delete c[k];
  // Invariante 99: la parte de la reserva de cada socio también es «reserva».
  c.socios = (c.socios as Array<Record<string, unknown>>).map((s) => {
    const t = { ...s };
    delete t.reserva_usd;
    delete t.reserva_mxn;
    return t;
  });
  return c;
}

describe('Balance — RESERVA DE OVERHAUL informativa (invariante 96)', () => {
  it('XB-TST: 3.5 h × 40 USD/hr = 140 USD × 18.6 (oficial del cierre) = 2,604 MXN — la MISMA reserva del reparto', async () => {
    const b = (await libro()).balance;
    expect(b).toMatchObject({
      reserva_overhaul_usd: 140,
      reserva_overhaul_mxn: 2604,
      reserva_overhaul_horas_hr: 3.5,
      reserva_overhaul_usd_hr: 40,
      reserva_overhaul_motores: 1,
      reserva_overhaul_tc: 18.6,
      reserva_overhaul_tc_dia: '2026-09-30',
      reserva_overhaul_incompleta: false,
    });
    const r = await reparto();
    expect(b.reserva_overhaul_usd).toBe(r.reserva_overhaul_usd);
    expect(b.reserva_overhaul_mxn).toBe(r.reserva_overhaul_mxn);
    expect(b.reserva_overhaul_tc).toBe(r.detalle.reserva.tc);
  });

  it('REGLA B: el USD del balance convierte gasto por gasto como el reparto ⇒ utilidad cobrada USD = saldo del reparto + fijos prorrateados (la única resta que el balance NO hace; la reserva ya no resta en ninguno, invariante 99)', async () => {
    const b = (await libro()).balance;
    const r = await reparto();
    expect(b.utilidad_cobrada_usd).toBe(
      Math.round(
        (r.saldo_disponible_usd + r.gastos.otros_prorrateados_usd) * 100,
      ) / 100,
    );
    // 4,838.80 = 4,488.80 + 350 en este mundo (la reserva de 140 se informa
    // en los dos libros, por socio, y no resta en ninguno).
    expect(b.utilidad_cobrada_usd).toBe(4838.8);
    expect(r.reserva_overhaul_usd).toBe(140);
    expect(r.reparto.map((s) => [s.reserva_usd, s.descuenta_reserva])).toEqual([
      [57.29, false],
      [82.71, false],
    ]);
    expect(b.socios.map((s) => [s.reserva_usd, s.descuenta_reserva])).toEqual([
      [82.71, false],
      [57.29, false],
    ]);
  });

  it('NO resta de nada: sin la tarifa de reserva, el bloque es el MISMO salvo las llaves de la reserva (USD y pesos)', async () => {
    const con = (await libro()).balance;
    const m = mundoPesos();
    m.reserva_overhaul = [];
    const sin = (await libro(m)).balance;
    expect(sinReserva(con)).toEqual(sinReserva(sin));
    // Sin tarifa y con horas voladas: 0 y el aviso de «incompleta».
    expect(sin).toMatchObject({
      reserva_overhaul_usd: 0,
      reserva_overhaul_mxn: 0,
      reserva_overhaul_horas_hr: 3.5,
      reserva_overhaul_usd_hr: 0,
      reserva_overhaul_motores: 0,
      reserva_overhaul_tc: null,
      reserva_overhaul_tc_dia: null,
      reserva_overhaul_incompleta: true,
    });
  });

  it('bimotor: la tarifa es la Σ de sus motores (40 + 15 = 55 USD/hr ⇒ 192.50 USD)', async () => {
    const m = mundoPesos();
    m.reserva_overhaul = [
      ...m.reserva_overhaul,
      { aeronave_id: AV, monto_por_hora_usd: '15', horas_acumuladas: '0' },
    ];
    const b = (await libro(m)).balance;
    expect(b.reserva_overhaul_usd_hr).toBe(55);
    expect(b.reserva_overhaul_motores).toBe(2);
    expect(b.reserva_overhaul_usd).toBe(192.5);
    expect(b.reserva_overhaul_mxn).toBe(3580.5);
  });

  it('las llaves van después de la cascada en pesos y ANTES de las que los specs fijan como últimas', async () => {
    const keys = Object.keys((await libro()).balance);
    const i = keys.indexOf('utilidad_cobrada_mxn');
    expect(keys.slice(i + 1, i + 1 + LLAVES_RESERVA.length)).toEqual(
      LLAVES_RESERVA,
    );
    expect(keys[keys.length - 1]).toBe('otros_ingresos_avion_usd');
  });

  it('general: cada avión trae SU reserva y la bandera `usd_por_gasto` viaja en la raíz y en cada libro; un avión sin vuelos ni tarifa (XB-DOS): 0, sin T.C.', async () => {
    const g = await general();
    expect(g.usd_por_gasto).toBe(true);
    const tst = g.aviones.find((a) => a.matricula === 'XB-TST')!;
    expect(tst.balance.reserva_overhaul_usd).toBe(140);
    expect(tst.balance.reserva_overhaul_mxn).toBe(2604);
    for (const a of g.aviones) expect(a.usd_por_gasto).toBe(true);
    const dos = await libro(mundoPesos(), AV2);
    expect(dos.usd_por_gasto).toBe(true);
    expect(dos.balance).toMatchObject({
      reserva_overhaul_usd: 0,
      reserva_overhaul_mxn: 0,
      reserva_overhaul_horas_hr: 0,
      reserva_overhaul_tc: null,
      reserva_overhaul_incompleta: false,
    });
  });
});
