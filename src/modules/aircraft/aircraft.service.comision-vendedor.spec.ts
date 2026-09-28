// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { AircraftService } from './aircraft.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ExpirationsService } from '../expirations/expirations.service';

/**
 * FICHA DEL AVIÓN (`aircraftMetrics().finanzas`) + COMISIÓN DEL VENDEDOR
 * (28-sep-2026, invariante 31): el pago al vendedor NO es gasto del avión
 * aunque traiga su `aeronave_id` (heredado del vuelo como referencia) —
 * misma regla que las categorías de empresa (`categoriaFueraDelAvion`).
 */
const AVION = 'aaaaaaaa-0000-4000-8000-000000000001';

function armar(gastos: Array<Record<string, unknown>>) {
  const handler = (tabla: string): { data: unknown } => {
    switch (tabla) {
      case 'aeronave':
        return {
          data: {
            id: AVION,
            matricula: 'N4142R',
            activa: true,
            servicio_intervalos: [],
            servicio_horas_base: 0,
            planeador_horas_base: 0,
            planeador_taco_ref: 0,
          },
        };
      case 'cobro_vuelo':
        return { data: [{ monto: 5000, moneda: 'MXN' }] };
      case 'gasto':
        return { data: gastos };
      case 'alerta_config':
        return { data: null };
      default:
        return { data: [] };
    }
  };
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'is',
      'not',
      'in',
      'gt',
      'gte',
      'lt',
      'lte',
      'or',
      'order',
      'limit',
      'range',
    ]) {
      q[m] = () => q;
    }
    const r = () =>
      Promise.resolve({ data: handler(tabla).data, error: null, count: null });
    q.maybeSingle = r;
    q.single = r;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      r().then(res, rej);
    return q;
  };
  const expirations = {
    findBlockingExpirations: jest.fn().mockResolvedValue([]),
  } as unknown as ExpirationsService;
  return new AircraftService(
    { service: { from } } as unknown as SupabaseService,
    expirations,
    {} as never,
  );
}

describe('aircraftMetrics().finanzas — COMISION_VENDEDOR (28-sep-2026)', () => {
  it('la comisión del vendedor (y el OTRO de empresa) NO restan en la ficha del avión', async () => {
    const m = await armar([
      { monto: 300, moneda: 'MXN', categoria: 'OPERACIONES' },
      { monto: 1600, moneda: 'MXN', categoria: 'COMISION_VENDEDOR' },
      { monto: 700, moneda: 'MXN', categoria: 'OTRO' },
    ]).aircraftMetrics(AVION);
    const mxn = (
      m.finanzas as Array<{
        moneda: string;
        ingresos: number;
        gastos: number;
        utilidad: number;
      }>
    ).find((f) => f.moneda === 'MXN');
    expect(mxn).toEqual({
      moneda: 'MXN',
      ingresos: 5000,
      gastos: 300,
      utilidad: 4700,
    });
  });
});
