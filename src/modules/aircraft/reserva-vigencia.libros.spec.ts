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
 * RESERVA DE OVERHAUL CON VIGENCIA EN LOS DOS LIBROS (10-nov-2026, API
 * 0.0.135, invariante 130). Pedido del cliente: «que pudiéramos ponerle
 * desde cuándo entra en vigor esa reserva de overhaul… que dijera ahí "a
 * partir de" y la fecha a partir de cuándo quiere que afecte».
 *
 * Mundo: el del reparto en pesos — XB-TST voló 3.5 h en septiembre (2.0 h
 * el 10-sep y 1.5 h el 15-sep) y su reserva LEGADA es de 40 USD/hr ⇒ 140
 * USD (2,604 MXN al oficial del 30-sep, 18.6). Con filas en
 * `reserva_overhaul_vigencia` manda el «a partir de» de cada tarifa.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;

function tcOficial() {
  return {
    oficialDetallePara: (dia: string) => {
      const tc = TC_OFICIAL_PESOS[dia];
      return Promise.resolve(
        tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
      );
    },
  } as never;
}

async function libro(m: Record<string, Fila[]>): Promise<BalanceAvionPayload> {
  const f = fakeSupabaseReparto(m);
  let enviado: BalanceAvionPayload | undefined;
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        enviado = p;
        return Promise.resolve(Buffer.from('x'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    tcOficial(),
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  await service.xlsx(AV, DESDE, HASTA);
  return enviado!;
}

async function reparto(m: Record<string, Fila[]>) {
  const f = fakeSupabaseReparto(m);
  const svc = new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    tcOficial(),
    {} as never,
  );
  svc.ahora = () => new Date('2026-10-19T15:00:00Z');
  const r = await svc.compute({ desde: DESDE, hasta: HASTA });
  return r.aviones.find((a) => a.aeronave.id === AV)!;
}

/** El mundo con tarifas con vigencia (la legada de 40 se queda donde está). */
function conVigencias(
  filas: Array<{
    desde: string;
    porMotor: number;
    motores?: number;
    avion?: string;
  }>,
): Record<string, Fila[]> {
  return {
    ...mundoPesos(),
    reserva_overhaul_vigencia: filas.map((f, i) => ({
      id: `rv-${i}`,
      aeronave_id: f.avion ?? AV,
      vigente_desde: f.desde,
      usd_hr_por_motor: String(f.porMotor),
      motores: f.motores ?? 1,
    })),
  };
}

describe('Reserva de overhaul con vigencia — balance y reparto', () => {
  it('la MISMA tarifa «desde antes del periodo»: los dos libros dan exactamente lo de la tabla legada (140 USD · 2,604 MXN) y solo se suman los aditivos de la vigencia', async () => {
    const legado = mundoPesos();
    const m = conVigencias([{ desde: '2026-01-01', porMotor: 40 }]);
    const [bL, bV, aL, aV] = await Promise.all([
      libro(legado),
      libro(m),
      reparto(legado),
      reparto(m),
    ]);
    expect(bV.balance.reserva_overhaul_usd).toBe(140);
    expect(bV.balance.reserva_overhaul_mxn).toBe(2604);
    // Todo lo demás del balance, idéntico al de la tabla legada.
    const sinAditivos = (b: BalanceAvionPayload['balance']) => {
      const resto: Record<string, unknown> = { ...b };
      delete resto.reserva_overhaul_tramos;
      delete resto.reserva_overhaul_horas_sin_tarifa_hr;
      delete resto.reserva_overhaul_primera_vigencia;
      return resto;
    };
    expect(sinAditivos(bV.balance)).toEqual(sinAditivos(bL.balance));
    expect(bL.balance).not.toHaveProperty('reserva_overhaul_tramos');
    expect(bV.balance).toMatchObject({
      reserva_overhaul_tramos: [
        {
          vigente_desde: '2026-01-01',
          usd_por_hora: 40,
          motores: 1,
          horas_hr: 3.5,
          usd: 140,
        },
      ],
      reserva_overhaul_horas_sin_tarifa_hr: 0,
      reserva_overhaul_primera_vigencia: null,
    });
    // El reparto, igual: mismos saldos y montos por socio.
    expect(aV.reserva_overhaul_usd).toBe(aL.reserva_overhaul_usd);
    expect(aV.saldo_disponible_usd).toBe(aL.saldo_disponible_usd);
    expect(aV.saldo_disponible_mxn).toBe(aL.saldo_disponible_mxn);
    expect(aV.reparto).toEqual(aL.reparto);
    expect(aL.detalle.reserva).not.toHaveProperty('tramos');
    expect(aV.detalle.reserva).toMatchObject({
      monto_usd: 140,
      tramos: [{ vigente_desde: '2026-01-01', horas_hr: 3.5, usd: 140 }],
      horas_sin_tarifa_hr: 0,
    });
  });

  it('«a partir del 15-sep»: solo las 1.5 h del 15-sep generan reserva (60 USD · 1,116 MXN) y la utilidad sube los 80 USD de las 2.0 h anteriores, en los DOS libros', async () => {
    const legado = mundoPesos();
    const m = conVigencias([{ desde: '2026-09-15', porMotor: 40 }]);
    const [bL, bV, aL, aV] = await Promise.all([
      libro(legado),
      libro(m),
      reparto(legado),
      reparto(m),
    ]);
    expect(bV.balance).toMatchObject({
      reserva_overhaul_usd: 60,
      reserva_overhaul_mxn: 1116,
      reserva_overhaul_horas_hr: 3.5,
      reserva_overhaul_usd_hr: 40,
      reserva_overhaul_incompleta: false,
      reserva_overhaul_tramos: [
        {
          vigente_desde: '2026-09-15',
          usd_por_hora: 40,
          horas_hr: 1.5,
          usd: 60,
        },
      ],
      reserva_overhaul_horas_sin_tarifa_hr: 2,
      reserva_overhaul_primera_vigencia: '2026-09-15',
    });
    expect(bV.balance.utilidad_cobrada_usd).toBe(
      r2(bL.balance.utilidad_cobrada_usd! + 80),
    );
    expect(bV.balance.utilidad_cobrada_mxn).toBe(
      r2(bL.balance.utilidad_cobrada_mxn! + 80 * 18.6),
    );
    // Reparto ≡ balance en la reserva, y el saldo sube lo mismo.
    expect(aV.reserva_overhaul_usd).toBe(60);
    expect(aV.reserva_overhaul_mxn).toBe(1116);
    expect(aV.saldo_disponible_usd).toBe(r2(aL.saldo_disponible_usd + 80));
    expect(aV.reserva_overhaul_incompleta).toBe(false);
    expect(aV.detalle.reserva).toMatchObject({
      horas_hr: 3.5,
      tarifa_hora_usd: 40,
      monto_usd: 60,
      tramos: [{ vigente_desde: '2026-09-15', horas_hr: 1.5, usd: 60 }],
      horas_sin_tarifa_hr: 2,
      primera_vigencia: '2026-09-15',
    });
    // A cada socio se le retiene su parte de los 60, no de los 140.
    expect(r2(aV.reparto.reduce((acc, s) => acc + s.reserva_usd, 0))).toBe(60);
  });

  it('el caso del cliente: «a partir del 1-oct» ⇒ septiembre (ya entregado sin reserva) queda en $0, sin marcarse como incompleta', async () => {
    const legado = mundoPesos();
    const m = conVigencias([{ desde: '2026-10-01', porMotor: 40 }]);
    const [bL, bV, aL, aV] = await Promise.all([
      libro(legado),
      libro(m),
      reparto(legado),
      reparto(m),
    ]);
    expect(bV.balance).toMatchObject({
      reserva_overhaul_usd: 0,
      reserva_overhaul_mxn: 0,
      reserva_overhaul_incompleta: false,
      reserva_overhaul_tramos: [],
      reserva_overhaul_horas_sin_tarifa_hr: 3.5,
      reserva_overhaul_primera_vigencia: '2026-10-01',
    });
    expect(bV.balance.utilidad_cobrada_usd).toBe(
      r2(bL.balance.utilidad_cobrada_usd! + 140),
    );
    expect(aV.reserva_overhaul_usd).toBe(0);
    expect(aV.reserva_overhaul_incompleta).toBe(false);
    expect(aV.saldo_disponible_usd).toBe(r2(aL.saldo_disponible_usd + 140));
    expect(aV.reparto.every((s) => s.reserva_usd === 0)).toBe(true);
  });

  it('cambio de tarifa a medio mes: 2.0 h a 40 y 1.5 h a 50 por motor × 2 motores ⇒ 80 + 150 = 230 USD', async () => {
    const m = conVigencias([
      { desde: '2026-01-01', porMotor: 40 },
      { desde: '2026-09-15', porMotor: 50, motores: 2 },
    ]);
    const [b, a] = await Promise.all([libro(m), reparto(m)]);
    expect(b.balance.reserva_overhaul_tramos).toEqual([
      {
        vigente_desde: '2026-01-01',
        usd_por_hora: 40,
        motores: 1,
        horas_hr: 2,
        usd: 80,
      },
      {
        vigente_desde: '2026-09-15',
        usd_por_hora: 100,
        motores: 2,
        horas_hr: 1.5,
        usd: 150,
      },
    ]);
    expect(b.balance.reserva_overhaul_usd).toBe(230);
    expect(b.balance.reserva_overhaul_mxn).toBe(r2(230 * 18.6));
    // La tarifa «del periodo» de los textos de un renglón: la última.
    expect(b.balance.reserva_overhaul_usd_hr).toBe(100);
    expect(b.balance.reserva_overhaul_motores).toBe(2);
    expect(a.reserva_overhaul_usd).toBe(230);
  });

  it('con vigencias, la tabla legada ya NO cuenta: un avión sin tarifa en la tabla nueva no reserva (y si voló, se avisa incompleta)', async () => {
    // Solo el OTRO avión tiene vigencia: el XB-TST conserva su fila legada
    // de 40 pero ya no se lee.
    const m = conVigencias([{ desde: '2026-01-01', porMotor: 55, avion: AV2 }]);
    const [b, a] = await Promise.all([libro(m), reparto(m)]);
    expect(b.balance).toMatchObject({
      reserva_overhaul_usd: 0,
      reserva_overhaul_incompleta: true,
    });
    expect(b.balance).not.toHaveProperty('reserva_overhaul_tramos');
    expect(a.reserva_overhaul_usd).toBe(0);
    expect(a.reserva_overhaul_incompleta).toBe(true);
  });
});
