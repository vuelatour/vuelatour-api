// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../profit-sharing/profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));

import { DashboardsService } from './dashboards.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * TABLERO EJECUTIVO + COMISIONES A CARGO DEL AVIÓN (revisión 6-oct-2026,
 * invariante 50): el saldo del reparto ya descuenta `comisiones_venta_usd`,
 * así que «Gastos» también las lleva — Ingresos − Gastos == Saldo, por avión
 * y en el resumen (antes de la regla las comisiones valen 0 y nada cambia).
 */
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Card del reparto con lo que lee `overview` (mundo del #501). */
function avion(comisiones: number) {
  return {
    aeronave: { id: 'av-1', matricula: 'XB-TST', modelo: 'C206' },
    ingresos: {
      cobrado_usd: 1793.72,
      pendiente_bruto_usd: 0,
      pendiente_cobro_usd: 0,
      otros_ingresos_vuelatour_usd: 0,
      vuelos_cobrados: 1,
      vuelos_pendientes: 0,
      comisiones_venta_usd: comisiones,
    },
    gastos: {
      directos_usd: 100,
      indirectos_usd: 50,
      permisos_usd: 0,
      otros_prorrateados_usd: 25,
    },
    reserva_overhaul_usd: 10,
    saldo_disponible_usd: r2(1793.72 - comisiones - 100 - 50 - 0 - 25 - 10),
  };
}

function armar(comisiones: number) {
  const service = new DashboardsService(
    {} as unknown as SupabaseService,
    {
      compute: () => Promise.resolve({ aviones: [avion(comisiones)] }),
    } as never,
    {} as never,
  );
  Object.assign(service as unknown as Record<string, unknown>, {
    fetchEstadosAbiertos: () => Promise.resolve([]),
    fetchVuelosPeriodo: () => Promise.resolve([]),
    buildTopClientes: () => Promise.resolve([]),
  });
  return service;
}

const Q = { desde: '2026-09-01', hasta: '2026-09-30' };

describe('dashboards.overview — comisiones a cargo del avión (invariante 50)', () => {
  it('«Gastos» incluye las comisiones del reparto: Ingresos − Gastos == Saldo por avión y en el resumen', async () => {
    const r = await armar(95.7).overview(Q);
    const a = r.por_avion[0];
    expect(a.gastos_usd).toBe(280.7);
    expect(a.comisiones_usd).toBe(95.7);
    expect(r2(a.ingresos_cobrado_usd - a.gastos_usd)).toBe(a.saldo_usd);
    expect(r.resumen.gastos_totales_usd).toBe(280.7);
    expect(r.resumen.comisiones_usd).toBe(95.7);
    expect(
      r2(r.resumen.ingresos_cobrados_usd - r.resumen.gastos_totales_usd),
    ).toBe(r.resumen.saldo_disponible_usd);
  });

  it('sin comisiones (antes de la vigencia) el tablero es el de siempre', async () => {
    const r = await armar(0).overview(Q);
    expect(r.por_avion[0].gastos_usd).toBe(185);
    expect(r.por_avion[0].comisiones_usd).toBe(0);
    expect(r.resumen.gastos_totales_usd).toBe(185);
    expect(
      r2(r.resumen.ingresos_cobrados_usd - r.resumen.gastos_totales_usd),
    ).toBe(r.resumen.saldo_disponible_usd);
  });
});
