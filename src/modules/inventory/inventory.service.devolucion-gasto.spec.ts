jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { InventoryService } from './inventory.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * DEVOLUCIÓN a bodega: `revertirGastoPorDevolucion` borra/reduce los gastos
 * BODEGA del avión. Desde el 0.0.52 (2-oct-2026) el error del DELETE se LEE:
 * con la puente `movimiento_bancario_gasto` (FK `on delete restrict`) borrar
 * un gasto conciliado FALLA, y tragárselo descontaba lo «revertido» sin
 * haber borrado nada (el avión seguía pagando la refacción devuelta y nadie
 * se enteraba). Ahora lo que no se pudo revertir queda en `sin_revertir`.
 */
type Res = { data: unknown; error: { code?: string; message: string } | null };

function armar(borrado: Res) {
  const deletes: string[] = [];
  const from = (tabla: string) => {
    let op = 'select';
    let id: unknown = null;
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'order', 'update']) {
      q[m] = () => q;
    }
    q.delete = () => {
      op = 'delete';
      return q;
    };
    q.eq = (col: string, val: unknown) => {
      if (col === 'id') id = val;
      return q;
    };
    const resolver = (): Res => {
      if (tabla === 'inventario_movimiento') {
        return { data: [{ id: 'S1' }], error: null };
      }
      if (tabla === 'gasto' && op === 'delete') {
        deletes.push(String(id));
        return borrado;
      }
      if (tabla === 'gasto') {
        return {
          data: [{ id: 'g-1', monto: 100, moneda: 'USD', tc_gasto: null }],
          error: null,
        };
      }
      return { data: null, error: null };
    };
    q.then = (res: (v: Res) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(res, rej);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const service = new InventoryService(supabase, {} as never);
  const revertir = (
    service as unknown as {
      revertirGastoPorDevolucion: (
        itemId: string,
        dto: Record<string, unknown>,
        costoUnitarioUsd: number,
        itemNombre: string,
        userId: string,
        tc?: number | null,
      ) => Promise<unknown>;
    }
  ).revertirGastoPorDevolucion.bind(service);
  return { revertir, deletes };
}

const DTO = { cantidad: 1, moneda: 'USD', aeronave_id: 'a-1' };

describe('revertirGastoPorDevolucion — el DELETE que falla NO se da por hecho', () => {
  it('borrado exitoso: nada pendiente', async () => {
    const { revertir, deletes } = armar({ data: null, error: null });
    await expect(
      revertir('it-1', DTO, 100, 'Aceite 15W-50', 'u-1'),
    ).resolves.toBeNull();
    expect(deletes).toEqual(['g-1']);
  });

  it('gasto conciliado (FK restrict de la puente): el monto queda SIN revertir', async () => {
    const { revertir, deletes } = armar({
      data: null,
      error: {
        code: '23503',
        message:
          'update or delete on table "gasto" violates foreign key constraint on table "movimiento_bancario_gasto"',
      },
    });
    await expect(
      revertir('it-1', DTO, 100, 'Aceite 15W-50', 'u-1'),
    ).resolves.toEqual({ sin_revertir: 100, moneda: 'USD', gastos_sin_tc: 0 });
    expect(deletes).toEqual(['g-1']);
  });
});
