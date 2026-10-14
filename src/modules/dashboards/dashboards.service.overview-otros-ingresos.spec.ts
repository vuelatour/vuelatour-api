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
 * TABLERO EJECUTIVO + OTROS INGRESOS DE LOS AVIONES (13-oct-2026, API 0.0.75,
 * invariante 67; hermano de `overview-comisiones.spec`): el saldo del reparto
 * ya SUMA los ingresos registrados en Ingresos con un avión. Van APARTE de
 * `ingresos_cobrados_usd` (que sigue siendo SOLO la venta), así que la
 * identidad de la invariante 50 se lee completa: ingresos + otros − gastos
 * == saldo, por avión y en el resumen.
 */
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Card del reparto con lo que lee `overview` (mundo del #501 + ING-14). */
function avion(otros?: number) {
  return {
    aeronave: { id: 'av-1', matricula: 'XB-TST', modelo: 'C206' },
    ingresos: {
      cobrado_usd: 1793.72,
      pendiente_bruto_usd: 0,
      pendiente_cobro_usd: 0,
      otros_ingresos_vuelatour_usd: 0,
      vuelos_cobrados: 1,
      vuelos_pendientes: 0,
      comisiones_venta_usd: 0,
      ...(otros != null ? { otros_ingresos_avion_usd: otros } : {}),
    },
    gastos: {
      directos_usd: 100,
      indirectos_usd: 50,
      permisos_usd: 0,
      otros_prorrateados_usd: 25,
    },
    reserva_overhaul_usd: 10,
    saldo_disponible_usd: r2(1793.72 - 100 - 50 - 0 - 25 - 10 + (otros ?? 0)),
  };
}

function armar(otros?: number) {
  const service = new DashboardsService(
    {} as unknown as SupabaseService,
    {
      compute: () => Promise.resolve({ aviones: [avion(otros)] }),
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

describe('dashboards.overview — otros ingresos de los aviones (invariante 67)', () => {
  it('con 2,327.54 de otros ingresos: la fila y el resumen los traen y ingresos + otros − gastos == saldo al centavo', async () => {
    const r = await armar(2327.54).overview(Q);
    const a = r.por_avion[0];
    expect(a.saldo_usd).toBe(3936.26);
    expect(a.otros_ingresos_avion_usd).toBe(2327.54);
    // La venta NO se mezcla: sigue siendo la del reparto.
    expect(a.ingresos_cobrado_usd).toBe(1793.72);
    expect(a.gastos_usd).toBe(185);
    expect(
      r2(a.ingresos_cobrado_usd + a.otros_ingresos_avion_usd - a.gastos_usd),
    ).toBe(a.saldo_usd);
    expect(Object.keys(a).slice(-1)).toEqual(['otros_ingresos_avion_usd']);
    expect(r.resumen.otros_ingresos_aviones_usd).toBe(2327.54);
    expect(r.resumen.ingresos_cobrados_usd).toBe(1793.72);
    expect(
      r2(
        r.resumen.ingresos_cobrados_usd +
          r.resumen.otros_ingresos_aviones_usd -
          r.resumen.gastos_totales_usd,
      ),
    ).toBe(r.resumen.saldo_disponible_usd);
    expect(Object.keys(r.resumen).slice(-1)).toEqual([
      'otros_ingresos_aviones_usd',
    ]);
  });

  it('sin el campo (reparto previo) ⇒ 0 y todo lo demás igual', async () => {
    const con = await armar(0).overview(Q);
    const sin = await armar().overview(Q);
    expect(sin.por_avion[0].otros_ingresos_avion_usd).toBe(0);
    expect(sin.resumen.otros_ingresos_aviones_usd).toBe(0);
    expect(sin).toEqual(con);
    expect(sin.por_avion[0].gastos_usd).toBe(185);
    expect(sin.resumen.saldo_disponible_usd).toBe(1608.72);
  });
});
