// Módulos pesados fuera del camino: notifications arrastra el gateway y
// `jose` (ESM puro) y vision el SDK de IA.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));

import { ConflictException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { CajaChicaService } from '../caja-chica/caja-chica.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import type { UpdateGastoDto } from './dto/expenses.dto';

/**
 * CANDADO DE CONCILIACIÓN con PAGOS PARCIALES (14-sep-2026). Antes el
 * candado miraba `gasto.conciliado`; ahora un gasto puede tener cargos del
 * banco ligados SIN estar cubierto (1 factura pagada en 2 cargos). Con
 * CUALQUIER cargo ligado:
 *  - no se editan `monto` / `moneda` / `medio_pago` (descuadraría la suma),
 *  - no se borra (dejaría el movimiento "conciliado" apuntando a nada),
 *  - el resto de campos (notas, vuelo, categoría) siguen editables.
 */

type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const GASTO = 'gasto-1';
const USER = 'user-1';

function fakeSupabase(db: Tablas) {
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let head = false;
      const ejecutar = (unico: boolean) => {
        const rows = (db[tabla] ?? [])
          .filter((r) => filtros.every((f) => f(r)))
          .map((r) => ({ ...r }));
        if (head) return { data: null, error: null, count: rows.length };
        return {
          data: unico ? (rows[0] ?? null) : rows,
          error: null,
          count: rows.length,
        };
      };
      const api: Record<string, unknown> = {
        select(_s?: string, opts?: { count?: string; head?: boolean }) {
          head = opts?.head === true;
          return api;
        },
        eq(col: string, val: unknown) {
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          filtros.push((r) => r[col] !== val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        order: () => api,
        limit: () => api,
        update: () => api,
        delete: () => api,
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        single: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
  };
  return { service } as unknown as SupabaseService;
}

/** Gasto de $277.79 con `n` cargos del banco ligados (parcial si no cubren). */
function mundo(cargos: number[], conciliado = false): Tablas {
  return {
    gasto: [
      {
        id: GASTO,
        monto: 277.79,
        moneda: 'MXN',
        medio_pago: 'TARJETA_CORP',
        categoria: 'PISTA',
        conciliado,
        vuelo_id: null,
        escala_id: null,
        aeronave_id: null,
        notas: null,
        usuario_captura_id: USER,
        created_at: '2026-09-07T15:00:00Z',
        compra_id: null,
      },
    ],
    movimiento_bancario: cargos.map((monto, i) => ({
      id: `mov-${i + 1}`,
      gasto_id: GASTO,
      monto,
      cuenta_bancaria_id: 'cta-mxn',
    })),
    gasto_reparto: [],
  };
}

function armar(db: Tablas) {
  return new ExpensesService(
    fakeSupabase(db),
    {} as NotificationsService,
    {} as PyservicesService,
    {} as VisionService,
    {
      numero: jest.fn().mockResolvedValue(1),
    } as unknown as ConfiguracionService,
    {
      fechaUltimaReposicionDe: jest.fn().mockResolvedValue(null),
    } as unknown as CajaChicaService,
    {} as IaUsoService,
  );
}

/** Corre y devuelve el error (o null): los candados se prueban por su 409. */
async function capturar(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe('update — candado con cargos del banco ligados', () => {
  it('con UN pago parcial ligado no se corrige el monto (409 con el conteo)', async () => {
    const svc = armar(mundo([152]));
    const err: unknown = await capturar(() =>
      svc.update(GASTO, { monto: 300 }, USER),
    );
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      message: string;
      error: string;
      details: { movimientos_ligados: number };
    };
    expect(body.error).toBe('GASTO_CONCILIADO');
    expect(body.message).toBe(
      'Este gasto tiene 1 cargo del banco ligado; desvincúlalo en Conciliación antes de corregirlo.',
    );
    expect(body.details.movimientos_ligados).toBe(1);
  });

  it('con DOS cargos el mensaje va en plural', async () => {
    const svc = armar(mundo([152, 125.79], true));
    const err: unknown = await capturar(() =>
      svc.update(GASTO, { moneda: 'USD' } as UpdateGastoDto, USER),
    );
    expect((err as ConflictException).getResponse()).toMatchObject({
      message:
        'Este gasto tiene 2 cargos del banco ligados; desvincúlalos en Conciliación antes de corregirlo.',
      details: { movimientos_ligados: 2 },
    });
  });

  it('el medio de pago también queda bajo candado', async () => {
    const svc = armar(mundo([152]));
    const err: unknown = await capturar(() =>
      svc.update(GASTO, { medio_pago: 'EFECTIVO' } as UpdateGastoDto, USER),
    );
    expect(err).toBeInstanceOf(ConflictException);
  });

  it('SIN cargos ligados no hay candado (aunque el gasto esté marcado conciliado por datos viejos)', async () => {
    const svc = armar(mundo([], true));
    const err: unknown = await capturar(() =>
      svc.update(GASTO, { monto: 300 }, USER),
    );
    expect(err).not.toBeInstanceOf(ConflictException);
  });

  it('los demás campos siguen editables con cargos ligados (notas)', async () => {
    const svc = armar(mundo([152]));
    const err: unknown = await capturar(() =>
      svc.update(GASTO, { notas: 'factura ASUR' }, USER),
    );
    expect(err).not.toBeInstanceOf(ConflictException);
  });
});

describe('remove — candado con cargos del banco ligados', () => {
  it('un pago PARCIAL (gasto aún no conciliado) ya impide borrar', async () => {
    const svc = armar(mundo([152]));
    const err: unknown = await capturar(() => svc.remove(GASTO, USER));
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      message:
        'Este gasto tiene 1 cargo del banco ligado; desvincúlalo en Conciliación antes de eliminarlo.',
      error: 'GASTO_CONCILIADO',
      details: { movimientos_ligados: 1 },
    });
  });

  it('sin cargos ligados pero con la bandera puesta sigue rebotando (dato viejo)', async () => {
    const svc = armar(mundo([], true));
    const err: unknown = await capturar(() => svc.remove(GASTO, USER));
    expect(err).toBeInstanceOf(ConflictException);
    expect(
      ((err as ConflictException).getResponse() as { error: string }).error,
    ).toBe('GASTO_CONCILIADO');
  });
});

/**
 * REVISIÓN 14-sep-2026 — el diálogo «Verificar» del panel manda SIEMPRE
 * `monto`, `moneda` y `medio_pago` (son campos del formulario, se toquen o
 * no). Si el candado mirara solo «¿viene el campo?», corregir la CATEGORÍA o
 * ligar el VUELO de un gasto con cargos ligados rebotaría 409 — justo lo que
 * la regla promete que sigue libre. El candado compara contra el valor
 * VIGENTE: reenviar el mismo dinero no es tocarlo.
 */
describe('update — reenviar los MISMOS valores no dispara el candado', () => {
  it('el payload completo del panel sin cambios de dinero pasa (cambia categoría)', async () => {
    const svc = armar(mundo([152]));
    const err: unknown = await capturar(() =>
      svc.update(
        GASTO,
        {
          monto: 277.79,
          moneda: 'MXN',
          medio_pago: 'TARJETA_CORP',
          categoria: 'FBO',
        } as UpdateGastoDto,
        USER,
      ),
    );
    expect(err).not.toBeInstanceOf(ConflictException);
  });

  it('el monto reenviado como string («277.79») tampoco es un cambio', async () => {
    const svc = armar(mundo([152]));
    const err: unknown = await capturar(() =>
      svc.update(GASTO, { monto: '277.79' as unknown as number }, USER),
    );
    expect(err).not.toBeInstanceOf(ConflictException);
  });

  it('un centavo de diferencia SÍ es un cambio (409)', async () => {
    const svc = armar(mundo([152]));
    const err: unknown = await capturar(() =>
      svc.update(GASTO, { monto: 277.8 }, USER),
    );
    expect(err).toBeInstanceOf(ConflictException);
  });

  it('reenviar el mismo medio pero cambiar la moneda sí rebota', async () => {
    const svc = armar(mundo([152]));
    const err: unknown = await capturar(() =>
      svc.update(
        GASTO,
        { medio_pago: 'TARJETA_CORP', moneda: 'USD' } as UpdateGastoDto,
        USER,
      ),
    );
    expect(err).toBeInstanceOf(ConflictException);
  });
});
