// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  fuenteTcLegible: (f: string | null | undefined) =>
    f === 'OPEN_ER_API' ? 'open.er-api' : (f ?? 'TC oficial'),
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));
// Sin la migración del cierre de mes (el eje de siempre).
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

import { ProfitSharingService } from './profit-sharing.service';
import { AircraftBalanceService } from '../aircraft/aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { BalanceAvionPayload } from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  V1,
  gastoBase,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';
import {
  HERNAN,
  TC_OFICIAL_PESOS,
  V3,
  fakeSupabaseReparto,
  mundoPesos,
} from './reparto-pesos.fixture-spec';

/**
 * LA CASCADA DEL BALANCE EN EL REPARTO (20-oct-2026, invariante 99).
 * Pedido del cliente con las capturas del Excel y de la card: «el total de
 * Gastos indirectos no cuadra… debemos hacer que cuadren», «la reserva de
 * overhaul… recuerda que eso no se resta, y debe venir cuánto es lo que debe
 * guardar cada socio… una opción para seleccionar en cada avión en cada
 * socio si se les restamos en las utilidades o solo darles el dato».
 *
 * Reglas (las prueba este spec sobre el mundo del reparto en pesos):
 *  1. La CATEGORÍA INDIRECTO sellada a un avión cuenta en el grupo
 *     INDIRECTO (antes EXCLUIDA): la misma hoja «Gastos Indirectos» del
 *     balance.
 *  2. La PROVISIÓN AFAC (tarifa × horas cobradas, la columna T del
 *     balance) RESTA del saldo, con la MISMA aritmética del balance
 *     (pesos con el z de costos del vuelo).
 *  3. La RESERVA DE OVERHAUL ya NO resta del saldo: se reparte por socio
 *     (`reserva_*`, «lo que debe guardar») y solo se DESCUENTA al socio con
 *     `descontar_reserva_overhaul` en `aeronave_socio`; VuelaTour retiene esa
 *     parte (`reserva_retenida_*`).
 *  4. Identidad con el balance: utilidad cobrada USD del balance = saldo
 *     del reparto + fijos prorrateados (la única resta que el balance no
 *     hace); la provisión AFAC es la MISMA cifra en los dos libros.
 *  5. PESOS PRIMERO (K de la cotización) también en el reparto.
 */

function reparto(m: Record<string, Fila[]>) {
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
  return svc;
}

async function avion(m: Record<string, Fila[]>) {
  const r = await reparto(m).compute({ desde: DESDE, hasta: HASTA });
  const a = r.aviones.find((x) => x.aeronave.id === AV);
  if (!a) throw new Error('sin XB-TST');
  return { r, a };
}

async function libro(m: Record<string, Fila[]>): Promise<BalanceAvionPayload> {
  const f = fakeSupabaseReparto(m);
  const enviados: { individual?: BalanceAvionPayload } = {};
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        enviados.individual = p;
        return Promise.resolve(Buffer.from('x'));
      },
      generateBalanceGeneralXlsx: () => Promise.resolve(Buffer.from('x')),
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
  await service.xlsx(AV, DESDE, HASTA);
  return enviados.individual!;
}

/** El mundo en pesos con la tarifa AFAC de la ficha del XB-TST (100 USD/hr). */
function conAfac(
  m: Record<string, Fila[]> = mundoPesos(),
): Record<string, Fila[]> {
  return {
    ...m,
    aeronave: m.aeronave.map((a) =>
      a.id === AV ? { ...a, permiso_afac_usd_hr: 100 } : a,
    ),
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

describe('Reparto — LA CASCADA DEL BALANCE (invariante 99)', () => {
  it('la bandera raíz `reparto_como_balance` viaja siempre (también vacía)', async () => {
    const r = await reparto(mundoPesos()).compute({
      desde: DESDE,
      hasta: HASTA,
    });
    expect(r.reparto_como_balance).toBe(true);
    const vacia = await reparto({ ...mundoPesos(), aeronave: [] }).compute({
      desde: DESDE,
      hasta: HASTA,
    });
    expect(vacia.reparto_como_balance).toBe(true);
  });

  it('1. la CATEGORÍA INDIRECTO sellada al avión cuenta en INDIRECTO (antes EXCLUIDA), igual que en la hoja del balance', async () => {
    const m = mundoPesos();
    m.gasto = [
      ...m.gasto,
      {
        ...gastoBase,
        id: 'g-ind',
        aeronave_id: AV,
        categoria: 'INDIRECTO',
        monto: 1000,
        tc_gasto: 20,
        notas: '1a quincena piloto',
      },
    ];
    const { a } = await avion(m);
    // REFACCION 100 USD + INDIRECTO 1,000 MXN ÷ 20 = 50 USD.
    expect(a.gastos.indirectos_usd).toBe(150);
    expect(a.gastos.indirectos_mxn).toBe(2840);
    const fila = a.detalle.gastos_por_categoria.find(
      (g) => g.categoria === 'INDIRECTO',
    );
    expect(fila).toMatchObject({ grupo: 'INDIRECTO', usd: 50, mxn: 1000 });
    // El balance la pinta en «Gastos Indirectos»: los dos libros, la misma
    // hoja (antes el Excel decía 388,937.57 y la card 318,737.57).
    const b = await libro(m);
    expect(b.balance.gastos_indirectos_mxn).toBe(2840);
    expect(b.balance.gastos_indirectos_usd).toBe(150);
  });

  it('2. PROVISIÓN AFAC = tarifa × horas cobradas por vuelo (pesos con el z del vuelo) y RESTA del saldo', async () => {
    const { a } = await avion(conAfac());
    const v501 = a.detalle.vuelos.find((v) => v.id === V1)!;
    const v502 = a.detalle.vuelos.find((v) => v.id === V3)!;
    // #501: 2 h cobradas × 100 = 200 USD; z = 20 (tc_gasto de sus MXN).
    expect(v501).toMatchObject({
      horas_cobradas_avion_hr: 2,
      afac_reservado_avion_usd: 200,
      afac_reservado_avion_mxn: 4000,
      tc_costos: 20,
    });
    // #502: 1.5 h × 100 = 150 USD; sin gastos MXN ⇒ z = K del vuelo (oficial
    // del día de la cotización, 18.25).
    expect(v502).toMatchObject({
      horas_cobradas_avion_hr: 1.5,
      afac_reservado_avion_usd: 150,
      afac_reservado_avion_mxn: 2737.5,
      tc_costos: 18.25,
    });
    expect(a.afac_reservado_usd).toBe(350);
    expect(a.afac_reservado_mxn).toBe(6737.5);
    expect(a.detalle.afac).toEqual({
      tarifa_usd_hr: 100,
      horas_cobradas_hr: 3.5,
      monto_usd: 350,
      monto_mxn: 6737.5,
    });
    // Saldo = 4,488.80 (sin AFAC) − 350; en pesos 84,388.80 − 6,737.50.
    expect(a.saldo_disponible_usd).toBe(4138.8);
    expect(a.saldo_disponible_mxn).toBe(77651.3);
    expect(a.pesos_sin_tc_usd).toBe(0);
  });

  it('3. la RESERVA no resta del saldo: por socio «lo que debe guardar», se le descuenta a TODOS (invariante 121) y VuelaTour la retiene; la bandera por socio ya no decide', async () => {
    const m = mundoPesos();
    const { a } = await avion(m);
    // 3.5 h × 40 = 140 USD × 18.6 = 2,604 MXN, repartida 40.92 / 59.08 por
    // residuo mayor y descontada a los dos: monto = utilidad − su reserva.
    expect(a.reserva_overhaul_usd).toBe(140);
    expect(a.reparto).toEqual([
      expect.objectContaining({
        socio_id: HERNAN,
        porcentaje: 40.92,
        utilidad_usd: 1836.82,
        utilidad_mxn: 34531.9,
        reserva_usd: 57.29,
        reserva_mxn: 1065.56,
        descuenta_reserva: true,
        monto_usd: 1779.53,
        monto_mxn: 33466.34,
      }),
      expect.objectContaining({
        porcentaje: 59.08,
        utilidad_usd: 2651.98,
        utilidad_mxn: 49856.9,
        reserva_usd: 82.71,
        reserva_mxn: 1538.44,
        descuenta_reserva: true,
        monto_usd: 2569.27,
        monto_mxn: 48318.46,
      }),
    ]);
    expect(a.reserva_retenida_usd).toBe(140);
    expect(a.reserva_retenida_mxn).toBe(2604);
    // El saldo del avión no cambia: lo retenido sale de la parte de cada socio.
    expect(a.saldo_disponible_usd).toBe(4488.8);
    expect(
      r2(
        a.reparto.reduce((s, x) => s + x.monto_usd, 0) + a.reserva_retenida_usd,
      ),
    ).toBe(a.saldo_disponible_usd);

    // La bandera por socio (invariante 99) ya no decide: con true, false o
    // ausente el resultado es el MISMO.
    for (const bandera of [true, false, undefined]) {
      const m2 = mundoPesos();
      m2.aeronave_socio = m2.aeronave_socio.map((s) => ({
        ...s,
        descontar_reserva_overhaul: bandera,
      }));
      const { a: a2 } = await avion(m2);
      expect(a2.reparto.map((s) => [s.monto_usd, s.descuenta_reserva])).toEqual(
        a.reparto.map((s) => [s.monto_usd, s.descuenta_reserva]),
      );
    }

    // El balance dice lo MISMO por socio (utilidad cobrada × % − su reserva).
    const b = await libro(m);
    const bh = b.balance.socios.find((s) => s.nombre === 'Hernán Pérez')!;
    expect(bh).toMatchObject({
      descuenta_reserva: true,
      reserva_usd: 57.29,
      reserva_mxn: 1065.56,
      utilidad_usd: 1980.04,
      monto_usd: 1922.75,
    });
    expect(bh.monto_mxn).toBe(r2(bh.utilidad_mxn! - 1065.56));
    const ba = b.balance.socios.find((s) => s.nombre !== 'Hernán Pérez')!;
    expect(ba).toMatchObject({
      descuenta_reserva: true,
      reserva_usd: 82.71,
    });
    expect(ba.monto_usd).toBe(r2(ba.utilidad_usd! - 82.71));
  });

  it('3b. reserva sin oficial del cierre: deja incompleta la parte de cada socio (se descuenta a todos)', async () => {
    const m = mundoPesos();
    const svc = (() => {
      const f = fakeSupabaseReparto(m);
      const s = new ProfitSharingService(
        f.supabase as unknown as SupabaseService,
        {} as never,
        { oficialDetallePara: () => Promise.resolve(null) } as never,
        {} as never,
      );
      s.ahora = () => new Date('2026-10-19T15:00:00Z');
      return s;
    })();
    const r = await svc.compute({ desde: DESDE, hasta: HASTA });
    const a = r.aviones.find((x) => x.aeronave.id === AV)!;
    // 1,280 de siempre (#502, comisión, REFACCION, FIJO USD) + los 140 de la
    // reserva (57.29 + 82.71), que se le descuenta a los dos sin pesos.
    expect(a.pesos_sin_tc_usd).toBe(r2(1280 + 140));
    expect(a.reserva_overhaul_mxn).toBe(0);
    // Sin oficial el saldo USD también cambia (GAS e ING-14 MXN sin T.C.
    // quedan fuera de los dólares): 2,070.24 × 40.92 % = 847.14 − 57.29.
    const hernan = a.reparto.find((s) => s.socio_id === HERNAN)!;
    expect(a.saldo_disponible_usd).toBe(2070.24);
    expect(hernan).toMatchObject({
      utilidad_usd: 847.14,
      reserva_usd: 57.29,
      reserva_mxn: 0,
      monto_usd: 789.85,
    });
  });

  it('4. IDENTIDAD: utilidad cobrada USD del balance = saldo del reparto + fijos prorrateados; la provisión AFAC es la MISMA cifra en los dos libros', async () => {
    const m = conAfac();
    const { a } = await avion(m);
    const b = await libro(m);
    expect(b.balance.utilidad_cobrada_usd).toBe(
      r2(a.saldo_disponible_usd + a.gastos.otros_prorrateados_usd),
    );
    // 4,488.80 = 4,138.80 + 350 con la provisión AFAC restada en los dos.
    expect(b.balance.utilidad_cobrada_usd).toBe(4488.8);
    expect(b.totales.permiso_afac_mxn).toBe(a.afac_reservado_mxn);
    expect(b.totales.permiso_afac_mxn).toBe(6737.5);
  });

  it('5. PESOS PRIMERO también en el reparto: un cobro MXN con T.C. del día distinto al K de la cotización cuenta al K', async () => {
    const m = mundoPesos();
    // #501: K 20; el cobro de 20,000 MXN tecleado a 19 (antes: 1,052.63 USD).
    m.cobro_vuelo = m.cobro_vuelo.map((c) =>
      c.id === 'c-1' ? { ...c, tc_usd_mxn: 19 } : c,
    );
    const { a } = await avion(m);
    const v501 = a.detalle.vuelos.find((v) => v.id === V1)!;
    expect(v501.cobrado_usd).toBe(2000);
    expect(v501.cobrado_avion_usd).toBe(1793.72);
    expect(v501.cobrado_avion_mxn).toBe(35874.4);
  });
});
