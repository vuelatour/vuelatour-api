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

interface Mundo {
  /** Gastos BODEGA del avión, del más reciente al más viejo. */
  gastos?: Array<{ id: string; monto: number; moneda: string }>;
  /** Resultado del DELETE por id (default: éxito). */
  borrado?: Record<string, Res>;
  /** Resultado del UPDATE por id (default: éxito). */
  ajuste?: Record<string, Res>;
  /** Gastos con un cargo del banco ligado (puente / espejo). */
  conBanco?: string[];
}

function armar(m: Mundo | Res = {}) {
  const w: Mundo =
    'error' in m || 'data' in m ? { borrado: { 'g-1': m as Res } } : m;
  const gastos = w.gastos ?? [{ id: 'g-1', monto: 100, moneda: 'USD' }];
  const deletes: string[] = [];
  const updates: string[] = [];
  const from = (tabla: string) => {
    let op = 'select';
    let id: unknown = null;
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'order', 'limit']) {
      q[m] = () => q;
    }
    q.delete = () => {
      op = 'delete';
      return q;
    };
    q.update = () => {
      op = 'update';
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
        return w.borrado?.[String(id)] ?? { data: null, error: null };
      }
      if (tabla === 'gasto' && op === 'update') {
        updates.push(String(id));
        return w.ajuste?.[String(id)] ?? { data: null, error: null };
      }
      if (tabla === 'gasto') {
        return {
          data: gastos.map((g) => ({ ...g, tc_gasto: null })),
          error: null,
        };
      }
      if (
        tabla === 'movimiento_bancario_gasto' ||
        (tabla === 'movimiento_bancario' && op === 'select')
      ) {
        return {
          data: (w.conBanco ?? []).map((gasto_id) => ({ gasto_id })),
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
  return { revertir, deletes, updates };
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

describe('revertirGastoPorDevolucion — un gasto que no se puede revertir NO corta el bucle (revisión 2-oct-2026)', () => {
  const FK = {
    data: null,
    error: {
      code: '23503',
      message:
        'update or delete on table "gasto" violates foreign key constraint on table "movimiento_bancario_gasto"',
    },
  };

  it('el más reciente falla al borrarse: se sigue con el siguiente, que sí se borra', async () => {
    const { revertir, deletes } = armar({
      gastos: [
        { id: 'g-nuevo', monto: 100, moneda: 'USD' },
        { id: 'g-viejo', monto: 100, moneda: 'USD' },
      ],
      borrado: { 'g-nuevo': FK },
    });
    await expect(
      revertir('it-1', DTO, 100, 'Aceite 15W-50', 'u-1'),
    ).resolves.toBeNull();
    expect(deletes).toEqual(['g-nuevo', 'g-viejo']);
  });

  it('un gasto con cargo del banco ligado se SALTA antes (ni DELETE ni UPDATE)', async () => {
    const { revertir, deletes, updates } = armar({
      gastos: [
        { id: 'g-banco', monto: 100, moneda: 'USD' },
        { id: 'g-libre', monto: 100, moneda: 'USD' },
      ],
      conBanco: ['g-banco'],
    });
    await expect(
      revertir('it-1', DTO, 100, 'Aceite 15W-50', 'u-1'),
    ).resolves.toBeNull();
    expect(deletes).toEqual(['g-libre']);
    expect(updates).toEqual([]);
  });

  it('el AJUSTE (update del monto) que falla tampoco se da por hecho', async () => {
    const { revertir, updates } = armar({
      gastos: [{ id: 'g-grande', monto: 300, moneda: 'USD' }],
      ajuste: { 'g-grande': { data: null, error: { message: 'caída' } } },
    });
    await expect(
      revertir('it-1', DTO, 100, 'Aceite 15W-50', 'u-1'),
    ).resolves.toEqual({ sin_revertir: 100, moneda: 'USD', gastos_sin_tc: 0 });
    expect(updates).toEqual(['g-grande']);
  });
});
