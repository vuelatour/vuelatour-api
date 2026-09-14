import { ConflictException } from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';

/**
 * PAGOS PARCIALES (14-sep-2026, caso real: UNA factura de ASUR cobrada en
 * DOS cargos de tarjeta). Aquí se congela el contrato de `link`:
 *  - varios cargos de la MISMA moneda caben mientras no rebasen el ticket;
 *  - `gasto.conciliado` = ¿la SUMA cubre el monto? (nunca "el último que
 *    tocó la liga"), también al DESVINCULAR;
 *  - moneda distinta (gasto USD ↔ cargo MXN) sigue siendo 1 ↔ 1;
 *  - lo que no cabe responde 409 GASTO_YA_CUBIERTO con `details`;
 *  - el 23514 del trigger de BD (carrera) se traduce al MISMO 409.
 */

type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

function fakeSupabase(db: Tablas, fallos: Record<string, unknown> = {}) {
  const valor = (r: Row, col: string): unknown => {
    if (!col.includes('->')) return r[col];
    const partes = col.split(/->>|->/).map((p) => p.trim());
    let v: unknown = r[partes[0]];
    for (const p of partes.slice(1)) {
      v = (v as Row | null)?.[p];
    }
    return v;
  };
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row = {};
      let sel = '';
      let head = false;
      const ejecutar = (unico: boolean) => {
        const err = fallos[`${tabla}:${op}`];
        if (err) return { data: null, error: err, count: null };
        const rows = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        if (op === 'update') rows.forEach((r) => Object.assign(r, patch));
        let out = rows.map((r) => ({ ...r }));
        if (sel.includes('cuenta:cuenta_bancaria')) {
          out = out.map((r) => ({
            ...r,
            cuenta:
              (db.cuenta_bancaria ?? []).find(
                (c) => c.id === r.cuenta_bancaria_id,
              ) ?? null,
          }));
        }
        if (head) return { data: null, error: null, count: out.length };
        return {
          data: unico ? (out[0] ?? null) : out,
          error: null,
          count: out.length,
        };
      };
      const api: Record<string, unknown> = {
        select(s?: string, opts?: { count?: string; head?: boolean }) {
          sel = s ?? '';
          head = opts?.head === true;
          return api;
        },
        eq(col: string, val: unknown) {
          filtros.push((r) => valor(r, col) === val);
          return api;
        },
        neq(col: string, val: unknown) {
          filtros.push((r) => valor(r, col) !== val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          filtros.push((r) => vals.includes(valor(r, col)));
          return api;
        },
        gte: () => api,
        lte: () => api,
        gt: () => api,
        lt: () => api,
        order: () => api,
        limit: () => api,
        range: () => api,
        update(p: Row) {
          op = 'update';
          patch = p;
          return api;
        },
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

const CTA_MXN = 'cta-mxn';
const CTA_USD = 'cta-usd';
const USER = 'user-1';

function mundo() {
  const db: Tablas = {
    cuenta_bancaria: [
      { id: CTA_MXN, moneda: 'MXN', tipo: 'BANCO' },
      { id: CTA_USD, moneda: 'USD', tipo: 'BANCO' },
    ],
    gasto: [
      {
        id: 'g-asur',
        monto: 277.79,
        moneda: 'MXN',
        conciliado: false,
        tc_gasto: null,
      },
      {
        id: 'g-usd',
        monto: 100,
        moneda: 'USD',
        conciliado: false,
        tc_gasto: null,
      },
    ],
    movimiento_bancario: [
      {
        id: 'm-1',
        cuenta_bancaria_id: CTA_MXN,
        fecha: '2026-09-07',
        monto: 152,
        gasto_id: null,
        conciliado: false,
      },
      {
        id: 'm-2',
        cuenta_bancaria_id: CTA_MXN,
        fecha: '2026-09-09',
        monto: 125.79,
        gasto_id: null,
        conciliado: false,
      },
      {
        id: 'm-3',
        cuenta_bancaria_id: CTA_MXN,
        fecha: '2026-09-10',
        monto: 50,
        gasto_id: null,
        conciliado: false,
      },
      {
        id: 'm-mxn-usd',
        cuenta_bancaria_id: CTA_MXN,
        fecha: '2026-09-07',
        monto: 1850,
        gasto_id: null,
        conciliado: false,
      },
      {
        id: 'm-mxn-usd-2',
        cuenta_bancaria_id: CTA_MXN,
        fecha: '2026-09-08',
        monto: 1850,
        gasto_id: null,
        conciliado: false,
      },
    ],
  };
  return db;
}

function armar(db: Tablas, fallos: Record<string, unknown> = {}) {
  return new ConciliacionService(
    // El `link` no lee configuración: basta un doble vacío.
    {} as unknown as ConstructorParameters<typeof ConciliacionService>[0],
    fakeSupabase(db, fallos),
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
}

const gastoDe = (db: Tablas, id: string) => db.gasto.find((g) => g.id === id)!;
const movDe = (db: Tablas, id: string) =>
  db.movimiento_bancario.find((m) => m.id === id)!;

describe('link — una factura pagada en DOS cargos', () => {
  it('primer cargo: liga, NO cubre y devuelve el faltante (gasto sigue pendiente)', async () => {
    const db = mundo();
    const svc = armar(db);
    const r = (await svc.link('m-1', 'g-asur', USER)) as Record<
      string,
      unknown
    >;
    expect(movDe(db, 'm-1').gasto_id).toBe('g-asur');
    expect(gastoDe(db, 'g-asur').conciliado).toBe(false);
    expect(r.gasto_conciliado).toBe(false);
    expect(r.monto_vinculado).toBe(152);
    expect(r.faltante).toBe(125.79);
  });

  it('segundo cargo: liga TAMBIÉN y ahora sí marca el gasto conciliado', async () => {
    const db = mundo();
    const svc = armar(db);
    await svc.link('m-1', 'g-asur', USER);
    const r = (await svc.link('m-2', 'g-asur', USER)) as Record<
      string,
      unknown
    >;
    expect(movDe(db, 'm-1').gasto_id).toBe('g-asur');
    expect(movDe(db, 'm-2').gasto_id).toBe('g-asur');
    expect(gastoDe(db, 'g-asur').conciliado).toBe(true);
    expect(r).toMatchObject({
      gasto_conciliado: true,
      monto_vinculado: 277.79,
      faltante: 0,
    });
  });

  it('tercer cargo que se pasa: 409 GASTO_YA_CUBIERTO con details y SIN tocar nada', async () => {
    const db = mundo();
    const svc = armar(db);
    await svc.link('m-1', 'g-asur', USER);
    await svc.link('m-2', 'g-asur', USER);
    let err: unknown;
    try {
      await svc.link('m-3', 'g-asur', USER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      message: string;
      error: string;
      details: {
        monto_gasto: number;
        suma_ligada: number;
        faltante: number;
        movimientos: Array<{ id: string; fecha: string; monto: number }>;
      };
    };
    expect(body.error).toBe('GASTO_YA_CUBIERTO');
    expect(body.message).toContain('Ese gasto ya está cubierto');
    expect(body.message).toContain('$277.79 de $277.79');
    expect(body.details.monto_gasto).toBe(277.79);
    expect(body.details.suma_ligada).toBe(277.79);
    expect(body.details.faltante).toBe(0);
    expect(body.details.movimientos.map((m) => m.id).sort()).toEqual([
      'm-1',
      'm-2',
    ]);
    // El movimiento rechazado queda pendiente (no se ligó a medias).
    expect(movDe(db, 'm-3').gasto_id).toBeNull();
    expect(gastoDe(db, 'g-asur').conciliado).toBe(true);
  });

  it('desvincular UNO de dos: el gasto vuelve a pendiente y el otro sigue ligado', async () => {
    const db = mundo();
    const svc = armar(db);
    await svc.link('m-1', 'g-asur', USER);
    await svc.link('m-2', 'g-asur', USER);
    const r = (await svc.link('m-2', null, USER)) as Record<string, unknown>;
    expect(movDe(db, 'm-2').gasto_id).toBeNull();
    expect(movDe(db, 'm-2').conciliado).toBe(false);
    // Sigue ligado el otro pago: el gasto NO se queda "sin banco" del todo.
    expect(movDe(db, 'm-1').gasto_id).toBe('g-asur');
    expect(gastoDe(db, 'g-asur').conciliado).toBe(false);
    // Al desvincular no se reportan cifras del gasto (campos aditivos null).
    expect(r.gasto_conciliado).toBeNull();
    expect(r.faltante).toBeNull();
  });

  it('desvincular el ÚLTIMO cargo de un gasto cubierto lo deja pendiente', async () => {
    const db = mundo();
    const svc = armar(db);
    await svc.link('m-1', 'g-asur', USER);
    await svc.link('m-2', 'g-asur', USER);
    await svc.link('m-1', null, USER);
    await svc.link('m-2', null, USER);
    expect(gastoDe(db, 'g-asur').conciliado).toBe(false);
  });

  it('re-ligar el MISMO gasto es idempotente (no rebota por "ya cubierto")', async () => {
    const db = mundo();
    const svc = armar(db);
    await svc.link('m-1', 'g-asur', USER);
    await svc.link('m-2', 'g-asur', USER);
    const r = (await svc.link('m-2', 'g-asur', USER)) as Record<
      string,
      unknown
    >;
    expect(r.gasto_conciliado).toBe(true);
    expect(movDe(db, 'm-2').gasto_id).toBe('g-asur');
  });
});

describe('link — moneda distinta sigue siendo 1 ↔ 1 (de ese cargo sale el TC)', () => {
  it('gasto USD contra cargo MXN: liga, cubre y deriva tc_gasto', async () => {
    const db = mundo();
    const svc = armar(db);
    const r = (await svc.link('m-mxn-usd', 'g-usd', USER)) as Record<
      string,
      unknown
    >;
    expect(gastoDe(db, 'g-usd').conciliado).toBe(true);
    expect(gastoDe(db, 'g-usd').tc_gasto).toBe(18.5);
    expect(r.gasto_conciliado).toBe(true);
    expect(r.faltante).toBe(0);
  });

  it('un SEGUNDO cargo en otra moneda rebota (no se suman pesos contra dólares)', async () => {
    const db = mundo();
    const svc = armar(db);
    await svc.link('m-mxn-usd', 'g-usd', USER);
    let err: unknown;
    try {
      await svc.link('m-mxn-usd-2', 'g-usd', USER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      error: string;
      message: string;
      details: { motivo: string };
    };
    expect(body.error).toBe('GASTO_YA_CUBIERTO');
    expect(body.details.motivo).toBe('MONEDA_DISTINTA');
    expect(body.message).toContain('Desvincula ese cargo antes de ligar otro.');
    expect(movDe(db, 'm-mxn-usd-2').gasto_id).toBeNull();
  });

  it('desvincular el cargo cruzado limpia el tc_gasto derivado de él', async () => {
    const db = mundo();
    const svc = armar(db);
    await svc.link('m-mxn-usd', 'g-usd', USER);
    await svc.link('m-mxn-usd', null, USER);
    expect(gastoDe(db, 'g-usd').conciliado).toBe(false);
    expect(gastoDe(db, 'g-usd').tc_gasto).toBeNull();
  });
});

describe('gastos-sin-banco — el pago parcial se ve, no desaparece', () => {
  it('un gasto con un cargo parcial sigue en la lista con monto_vinculado y faltante', async () => {
    const db = mundo();
    db.gasto[0].medio_pago = 'TARJETA_CORP';
    db.gasto[0].fecha_gasto = '2026-09-07';
    db.gasto[1].medio_pago = 'TARJETA_CORP';
    db.gasto[1].fecha_gasto = '2026-09-07';
    const svc = armar(db);
    await svc.link('m-1', 'g-asur', USER);

    const r = await svc.gastosSinBanco('2026-09-01', '2026-09-30');
    const asur = r.data.find((g) => g.id === 'g-asur')!;
    expect(asur.monto_vinculado).toBe(152);
    expect(asur.faltante).toBe(125.79);
    expect(asur.parcial).toBe(true);
    // El que no tiene nada del banco: 0 vinculado y falta todo.
    const usd = r.data.find((g) => g.id === 'g-usd')!;
    expect(usd.monto_vinculado).toBe(0);
    expect(usd.faltante).toBe(100);
    expect(usd.parcial).toBe(false);
  });

  it('cuando la suma CUBRE el gasto, sale de la lista (conciliado)', async () => {
    const db = mundo();
    db.gasto[0].medio_pago = 'TARJETA_CORP';
    db.gasto[0].fecha_gasto = '2026-09-07';
    db.gasto[1].medio_pago = 'TARJETA_CORP';
    db.gasto[1].fecha_gasto = '2026-09-07';
    const svc = armar(db);
    await svc.link('m-1', 'g-asur', USER);
    await svc.link('m-2', 'g-asur', USER);
    const r = await svc.gastosSinBanco('2026-09-01', '2026-09-30');
    expect(r.data.some((g) => g.id === 'g-asur')).toBe(false);
  });
});

describe('link — carrera resuelta en la BD', () => {
  it('el 23514 del trigger tg_mov_bancario_gasto_suma se traduce a 409 GASTO_YA_CUBIERTO', async () => {
    const db = mundo();
    const svc = armar(db, {
      'movimiento_bancario:update': {
        code: '23514',
        message:
          'GASTO_YA_CUBIERTO: los cargos ligados al gasto g-asur suman 277.79 y con este (50.00) rebasan su monto (277.79)',
      },
    });
    let err: unknown;
    try {
      await svc.link('m-3', 'g-asur', USER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect(
      ((err as ConflictException).getResponse() as { error: string }).error,
    ).toBe('GASTO_YA_CUBIERTO');
  });

  it('el 23505 del índice único viejo (migración sin aplicar) sigue dando 409', async () => {
    const db = mundo();
    const svc = armar(db, {
      'movimiento_bancario:update': {
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      },
    });
    await expect(svc.link('m-2', 'g-asur', USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

/**
 * REVISIÓN 14-sep-2026 — CAMBIO DE COMPORTAMIENTO conocido: la regla mira la
 * SUMA, así que un PRIMER cargo que ya rebasa el ticket también se rechaza
 * (antes se podía ligar cualquier movimiento a cualquier gasto). El 409 debe
 * explicar ESE caso: decir «ya está cubierto: $0.00 de $277.79» mandaba a la
 * oficina a buscar un cargo que no existe.
 */
describe('link — el PRIMER cargo ya rebasa el gasto', () => {
  it('409 con el texto del CARGO (no «ya cubierto») y details.monto_nuevo', async () => {
    const db = mundo();
    // Cargo de $1,850 (el de la compra USD) contra el gasto MXN de $277.79.
    const svc = armar(db);
    await expect(svc.link('m-mxn-usd', 'g-asur', USER)).rejects.toThrow(
      ConflictException,
    );
    let body: Record<string, unknown> = {};
    try {
      await svc.link('m-mxn-usd', 'g-asur', USER);
    } catch (e) {
      body = (e as ConflictException).getResponse() as Record<string, unknown>;
    }
    expect(body.error).toBe('GASTO_YA_CUBIERTO');
    expect(String(body.message)).toContain('$1,850.00');
    expect(String(body.message)).toContain('MAYOR que el gasto');
    expect(String(body.message)).not.toContain('ya está cubierto');
    expect(body.details).toMatchObject({
      motivo: 'GASTO_YA_CUBIERTO',
      monto_gasto: 277.79,
      suma_ligada: 0,
      monto_nuevo: 1850,
      moneda: 'MXN',
      movimientos: [],
    });
    // Y NADA se escribió: el gasto sigue sin cargos y sin conciliar.
    expect(movDe(db, 'm-mxn-usd').gasto_id).toBeNull();
    expect(gastoDe(db, 'g-asur').conciliado).toBe(false);
  });
});
