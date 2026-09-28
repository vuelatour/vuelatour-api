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
 * TABLERO DE GASTOS + COMISIÓN DEL VENDEDOR (28-sep-2026, invariante 31):
 * el pago al vendedor es dinero de VuelaTour — va a `gastos_empresa_usd`
 * aunque traiga el avión del vuelo sellado, y queda FUERA de `gastos_usd` y
 * `costo_hora_usd` del avión (misma regla que las categorías de empresa).
 */
const AV = 'av-1';

function armar(gastos: Array<Record<string, unknown>>) {
  const from = () => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'eq', 'neq', 'gte', 'lte', 'is']) {
      q[m] = () => q;
    }
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(res);
    return q;
  };
  const service = new DashboardsService(
    { service: { from } } as unknown as SupabaseService,
    {} as never,
    {} as never,
  );
  Object.assign(service as unknown as Record<string, unknown>, {
    fetchAeronavesActivas: () =>
      Promise.resolve([{ id: AV, matricula: 'N4142R', modelo: 'C206' }]),
    fetchGastosPeriodo: () => Promise.resolve(gastos),
    fetchVuelosHoras: () => Promise.resolve([]),
    horasPorAvion: () => Promise.resolve(new Map([[AV, 10]])),
  });
  return service;
}

const gasto = (id: string, categoria: string, monto: number) => ({
  id,
  aeronave_id: AV,
  usuario_captura_id: 'u-1',
  categoria,
  monto,
  moneda: 'USD',
  tc_gasto: null,
  medio_pago: 'TRANSFERENCIA',
  tarjeta_terminacion: null,
});

describe('dashboards.gastos — COMISION_VENDEDOR (28-sep-2026)', () => {
  it('va a gastos_empresa_usd y NO al avión (gastos_usd / costo_hora_usd sin cambio)', async () => {
    const sin = await armar([gasto('g-op', 'OPERACIONES', 100)]).gastos({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    const con = await armar([
      gasto('g-op', 'OPERACIONES', 100),
      gasto('g-cv', 'COMISION_VENDEDOR', 116),
    ]).gastos({ desde: '2026-09-01', hasta: '2026-09-30' });
    expect(con.por_avion).toEqual(sin.por_avion);
    expect(con.por_avion[0].gastos_usd).toBe(100);
    expect(con.por_avion[0].costo_hora_usd).toBe(10);
    expect(con.resumen.gastos_empresa_usd).toBe(116);
    expect(sin.resumen.gastos_empresa_usd).toBe(0);
    // El dinero no desaparece: entra al total del tablero.
    expect(con.resumen.gastos_totales_usd).toBe(216);
    expect(con.resumen.gastos_avion_usd).toBe(100);
  });
});
