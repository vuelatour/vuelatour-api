import { ConciliacionService } from './conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { TipoMovimientoBancario } from './dto/conciliacion.dto';

/**
 * AUTO-CRUCE RESILIENTE Y RE-CRUCE (15-sep-2026).
 *
 * Contexto: el 15-sep el trigger `tg_mov_bancario_gasto_suma` comparaba un
 * ENUM de moneda contra text y CADA liga reventaba; la importación murió al
 * 37 % con 101 movimientos ya insertados y 0 conciliados, y no existía forma
 * de volver a cruzarlos (re-importar respondía «101 duplicados»). Aquí se
 * congela lo que impide que eso vuelva a pasar:
 *  - ningún movimiento puede tumbar el job: se cuenta y se sigue;
 *  - `POST /conciliacion/auto-match` vuelve a cruzar lo pendiente;
 *  - el auto-cruce desempata por tarjeta pero JAMÁS liga lo ambiguo;
 *  - los traspasos internos se clasifican solos;
 *  - un gasto capturado DESPUÉS del estado de cuenta se cruza solo.
 */

type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

function fakeSupabase(db: Tablas, fallos: Record<string, unknown> = {}) {
  let seq = 0;
  const num = (v: unknown) => Number(v);
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' | 'insert' = 'select';
      let patch: Row = {};
      let aInsertar: Row[] = [];
      let sel = '';
      let limite: number | null = null;
      const ejecutar = (unico: boolean) => {
        const err = fallos[`${tabla}:${op}`];
        if (err) return { data: null, error: err, count: null };
        if (op === 'insert') {
          const creados = aInsertar.map((r) => ({
            id: `${tabla}-${++seq}`,
            ...r,
          }));
          db[tabla] = [...(db[tabla] ?? []), ...creados];
          const copia = creados.map((r) => ({ ...r }));
          return {
            data: unico ? (copia[0] ?? null) : copia,
            error: null,
            count: copia.length,
          };
        }
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
        if (sel.includes('proveedor:proveedor')) {
          out = out.map((r) => ({
            ...r,
            proveedor:
              (db.proveedor ?? []).find((p) => p.id === r.proveedor_id) ?? null,
          }));
        }
        const total = out.length;
        if (limite != null) out = out.slice(0, limite);
        return {
          data: unico ? (out[0] ?? null) : out,
          error: null,
          count: total,
        };
      };
      const api: Record<string, unknown> = {
        select(s?: string) {
          sel = s ?? '';
          return api;
        },
        insert(r: Row | Row[]) {
          op = 'insert';
          aInsertar = Array.isArray(r) ? r : [r];
          return api;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
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
        is(col: string, val: unknown) {
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        ilike(col: string, val: string) {
          filtros.push(
            (r) =>
              String((r[col] as string) ?? '').toLowerCase() ===
              val.toLowerCase(),
          );
          return api;
        },
        in(col: string, vals: unknown[]) {
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        gte(col: string, val: unknown) {
          filtros.push((r) =>
            typeof val === 'number'
              ? num(r[col]) >= val
              : String(r[col]) >= String(val),
          );
          return api;
        },
        lte(col: string, val: unknown) {
          filtros.push((r) =>
            typeof val === 'number'
              ? num(r[col]) <= val
              : String(r[col]) <= String(val),
          );
          return api;
        },
        gt(col: string, val: unknown) {
          filtros.push((r) =>
            typeof val === 'number'
              ? num(r[col]) > val
              : String(r[col]) > String(val),
          );
          return api;
        },
        lt: () => api,
        or: () => api,
        order: () => api,
        range: () => api,
        limit(n: number) {
          limite = n;
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

const CTA = 'cta-mxn';
const USER = 'user-1';

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [{ id: CTA, moneda: 'MXN', tipo: 'BANCO' }],
    tarjeta_corporativa: [
      { terminacion: '0577', activa: true },
      { terminacion: '6256', activa: true },
    ],
    conciliacion_clasificacion: [],
    proveedor: [{ id: 'prov-asur', nombre: 'ASUR' }],
    gasto: [],
    movimiento_bancario: [],
    estado_cuenta_archivo: [],
    ...extra,
  };
}

function armar(db: Tablas, fallos: Record<string, unknown> = {}) {
  return new ConciliacionService(
    {
      get: () => '',
    } as unknown as ConstructorParameters<typeof ConciliacionService>[0],
    fakeSupabase(db, fallos),
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
}

const cargo = (fecha: string, monto: number, extra: Row = {}) => ({
  fecha,
  monto,
  tipo: TipoMovimientoBancario.CARGO,
  ...extra,
});

const gastoBase = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  monto,
  moneda: 'MXN',
  fecha_gasto: '2026-09-08',
  medio_pago: 'TARJETA_CORP',
  conciliado: false,
  tc_gasto: null,
  tarjeta_terminacion: null,
  lugar: null,
  notas: null,
  categoria: 'ATERRIZAJE',
  vuelo_id: null,
  proveedor_id: null,
  ...extra,
});

describe('ejecutarImport — ningún movimiento puede tumbar el job', () => {
  it('un throw en el cruce se cuenta como error y la importación TERMINA', async () => {
    const db = mundo();
    const svc = armar(db);
    // El trigger del 15-sep reventaba en la liga: se simula el mismo fallo.
    const espia = jest
      .spyOn(
        svc as unknown as {
          autoMatchCargo: (...a: unknown[]) => Promise<unknown>;
        },
        'autoMatchCargo',
      )
      .mockRejectedValueOnce(
        new Error('operator does not exist: public.moneda = text'),
      )
      .mockResolvedValue({
        movimiento_id: 'x',
        resultado: 'SIN_CANDIDATO',
        criterio: null,
        motivo: 'sin candidatos',
        candidatos_n: 0,
      });

    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          cargo('2026-09-08', 100),
          cargo('2026-09-08', 200),
          cargo('2026-09-09', 300),
        ],
      },
      USER,
    )) as Record<string, unknown>;

    expect(espia).toHaveBeenCalledTimes(3);
    expect(r.importados).toBe(3);
    expect(r.errores).toBe(1);
    expect(r.sin_candidato).toBe(2);
    // Los 3 movimientos QUEDARON insertados (como el 15-sep en prod).
    expect(db.movimiento_bancario).toHaveLength(3);
  });

  it('el detalle dice POR QUÉ quedó pendiente cada movimiento', async () => {
    const db = mundo();
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [cargo('2026-09-08', 999.99)],
      },
      USER,
    )) as Record<string, unknown>;
    const detalle = r.detalle as Array<{ resultado: string; motivo: string }>;
    expect(r.sin_candidato).toBe(1);
    expect(detalle[0].resultado).toBe('SIN_CANDIDATO');
    expect(detalle[0].motivo).toContain('$999.99');
  });
});

describe('auto-cruce de un CARGO — liga lo inequívoco, nunca lo ambiguo', () => {
  it('candidato único por monto (±1 centavo): lo liga', async () => {
    const db = mundo({
      gasto: [gastoBase('g-1', 125.82, { lugar: 'Aeropuerto de Cozumel' })],
    });
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          cargo('2026-09-08', 125.82, { descripcion: 'AEROPUERTO DE COZUMEL' }),
        ],
      },
      USER,
    )) as Record<string, unknown>;
    expect(r.conciliados).toBe(1);
    expect(db.gasto[0].conciliado).toBe(true);
    expect(db.movimiento_bancario[0].gasto_id).toBe('g-1');
  });

  it('DOS gastos del mismo monto sin nada que los desempate: AMBIGUO', async () => {
    const db = mundo({
      gasto: [
        gastoBase('g-1', 125.82, { lugar: 'Aeropuerto de Cozumel' }),
        gastoBase('g-2', 125.82, { lugar: 'Aeropuerto de Cozumel' }),
      ],
    });
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          cargo('2026-09-08', 125.82, {
            descripcion: 'AEROPUERTO DE COZUMEL',
            referencia: '174465',
          }),
        ],
      },
      USER,
    )) as Record<string, unknown>;
    expect(r.ambiguos).toBe(1);
    expect(r.conciliados).toBe(0);
    expect(db.movimiento_bancario[0].conciliado).toBeFalsy();
    expect(db.gasto.every((g) => g.conciliado === false)).toBe(true);
    expect((r.detalle as Array<{ motivo: string }>)[0].motivo).toContain(
      'a mano',
    );
  });

  it('la TERMINACIÓN de la tarjeta desempata los dos cargos de Cozumel', async () => {
    const db = mundo({
      gasto: [
        gastoBase('g-1', 125.82, {
          lugar: 'Aeropuerto de Cozumel',
          tarjeta_terminacion: '0577',
        }),
        gastoBase('g-2', 125.82, {
          lugar: 'Aeropuerto de Cozumel',
          tarjeta_terminacion: '6256',
        }),
      ],
    });
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          cargo('2026-09-08', 125.82, {
            descripcion: 'AEROPUERTO DE COZUMEL',
            referencia: '9155656256',
          }),
        ],
      },
      USER,
    )) as Record<string, unknown>;
    expect(r.conciliados).toBe(1);
    expect((r.por_criterio as Record<string, number>).TARJETA).toBe(1);
    expect(db.movimiento_bancario[0].gasto_id).toBe('g-2');
  });

  it('tolera un centavo de diferencia (redondeo de la terminal)', async () => {
    const db = mundo({ gasto: [gastoBase('g-1', 480.5)] });
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [cargo('2026-09-08', 480.51)],
      },
      USER,
    )) as Record<string, unknown>;
    expect(r.conciliados).toBe(1);
  });

  it('un gasto EFECTIVO jamás se cruza con el banco', async () => {
    const db = mundo({
      gasto: [gastoBase('g-1', 125.82, { medio_pago: 'EFECTIVO' })],
    });
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [cargo('2026-09-08', 125.82)],
      },
      USER,
    )) as Record<string, unknown>;
    expect(r.conciliados).toBe(0);
    expect(r.sin_candidato).toBe(1);
  });
});

describe('traspasos internos — ya no son pendientes eternos', () => {
  it('clasifica el abono «SEL TRASPASO ENTRE CUENTAS» y lo da por conciliado', async () => {
    const db = mundo();
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          {
            fecha: '2026-09-08',
            monto: 50000,
            tipo: TipoMovimientoBancario.ABONO,
            descripcion: 'SEL TRASPASO ENTRE CUENTAS',
          },
        ],
      },
      USER,
    )) as Record<string, unknown>;
    expect(r.traspasos).toBe(1);
    expect(r.conciliados_auto).toBe(1);
    const mov = db.movimiento_bancario[0];
    expect(mov.conciliado).toBe(true);
    expect(mov.clasificacion_id).toBeTruthy();
    expect(String(mov.notas)).toContain('Regla:');
    expect(db.conciliacion_clasificacion[0].nombre).toBe(
      'Traspaso entre cuentas',
    );
  });
});

describe('autoMatchPendientes — el RESCATE de lo que quedó pendiente', () => {
  it('vuelve a cruzar los movimientos ya insertados y sin conciliar', async () => {
    const db = mundo({
      gasto: [gastoBase('g-1', 277.79, { lugar: 'Aeropuerto de Cancún' })],
      movimiento_bancario: [
        {
          id: 'm-huerfano',
          cuenta_bancaria_id: CTA,
          fecha: '2026-09-08',
          tipo: TipoMovimientoBancario.CARGO,
          monto: 277.79,
          descripcion: 'ASUR CANCUN',
          referencia: '174465',
          conciliado: false,
          gasto_id: null,
          notas: null,
        },
      ],
    });
    const svc = armar(db);
    const r = await svc.autoMatchPendientes(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(r.revisados).toBe(1);
    expect(r.conciliados).toBe(1);
    expect(r.errores).toBe(0);
    expect(db.movimiento_bancario[0].gasto_id).toBe('g-1');
    expect(db.gasto[0].conciliado).toBe(true);
    expect(r.detalle[0]).toMatchObject({
      movimiento_id: 'm-huerfano',
      resultado: 'CONCILIADO',
    });
  });

  it('no toca los que YA están conciliados', async () => {
    const db = mundo({
      movimiento_bancario: [
        {
          id: 'm-ok',
          cuenta_bancaria_id: CTA,
          fecha: '2026-09-08',
          tipo: TipoMovimientoBancario.CARGO,
          monto: 100,
          conciliado: true,
          gasto_id: 'g-x',
        },
      ],
    });
    const svc = armar(db);
    const r = await svc.autoMatchPendientes({}, USER);
    expect(r.revisados).toBe(0);
  });

  it('rechaza una ventana invertida', async () => {
    const svc = armar(mundo());
    await expect(
      svc.autoMatchPendientes(
        { desde: '2026-09-30', hasta: '2026-09-01' },
        USER,
      ),
    ).rejects.toThrow('desde no puede ser posterior a hasta');
  });
});

describe('intentarCruzarGasto — el gasto capturado DESPUÉS del estado de cuenta', () => {
  const conCargo = (extra: Row = {}) =>
    mundo({
      movimiento_bancario: [
        {
          id: 'm-1',
          cuenta_bancaria_id: CTA,
          fecha: '2026-09-08',
          tipo: TipoMovimientoBancario.CARGO,
          monto: 125.82,
          descripcion: 'AEROPUERTO DE COZUMEL',
          referencia: '9155656256',
          conciliado: false,
          gasto_id: null,
        },
      ],
      ...extra,
    });

  it('liga el cargo pendiente que cuadra sin ambigüedad', async () => {
    const db = conCargo({
      gasto: [gastoBase('g-1', 125.82, { lugar: 'Aeropuerto de Cozumel' })],
    });
    const svc = armar(db);
    const r = await svc.intentarCruzarGasto('g-1', USER);
    expect(r.ligado).toBe(true);
    expect(r.movimiento_id).toBe('m-1');
    expect(db.movimiento_bancario[0].gasto_id).toBe('g-1');
    expect(db.gasto[0].conciliado).toBe(true);
  });

  it('un gasto de EFECTIVO no toca el banco', async () => {
    const db = conCargo({
      gasto: [gastoBase('g-1', 125.82, { medio_pago: 'EFECTIVO' })],
    });
    const svc = armar(db);
    const r = await svc.intentarCruzarGasto('g-1', USER);
    expect(r.ligado).toBe(false);
    expect(db.movimiento_bancario[0].gasto_id).toBeNull();
  });

  it('NUNCA lanza: un fallo de BD se devuelve como motivo', async () => {
    const db = conCargo({ gasto: [gastoBase('g-1', 125.82)] });
    const svc = armar(db, { 'gasto:select': { message: 'boom' } });
    const r = await svc.intentarCruzarGasto('g-1', USER);
    expect(r.ligado).toBe(false);
    expect(r.motivo).toBeTruthy();
  });

  it('no liga si DOS cargos iguales podrían ser el gasto', async () => {
    const db = conCargo({
      gasto: [gastoBase('g-1', 125.82, { lugar: 'Aeropuerto de Cozumel' })],
    });
    db.movimiento_bancario.push({
      id: 'm-2',
      cuenta_bancaria_id: CTA,
      fecha: '2026-09-08',
      tipo: TipoMovimientoBancario.CARGO,
      monto: 125.82,
      descripcion: 'AEROPUERTO DE COZUMEL',
      referencia: '0025830577',
      conciliado: false,
      gasto_id: null,
    });
    const svc = armar(db);
    const r = await svc.intentarCruzarGasto('g-1', USER);
    expect(r.ligado).toBe(false);
    expect(r.motivo).toContain('a mano');
  });
});

/**
 * REVISIÓN ADVERSARIA (15-sep-2026). Tres huecos que quedaban abiertos en la
 * primera versión del auto-cruce y que rompían la regla rectora («liga solo
 * lo inequívoco» / «nunca mezcla divisas»).
 */
describe('candados de la revisión adversaria', () => {
  it('TC implícito: con DOS gastos USD plausibles NO desempata la descripción', async () => {
    // El cargo es de $2,000 MXN y ningún gasto en pesos cuadra. En dólares
    // hay dos gastos cuyo TC cae en la banda 15-25 — pero sus MONTOS no
    // coinciden con nada: desempatar ahí por texto sería ligar «por
    // parecerse», que es justo lo prohibido.
    const db = mundo({
      gasto: [
        gastoBase('g-usd-asa', 100, {
          moneda: 'USD',
          lugar: 'ASA Cancún',
          notas: 'Combustible AVGAS',
        }),
        gastoBase('g-usd-otro', 95, { moneda: 'USD', lugar: 'Ferretería' }),
      ],
    });
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [cargo('2026-09-08', 2000, { descripcion: 'ASA CANCUN' })],
      },
      USER,
    )) as Record<string, unknown>;
    expect(r.conciliados).toBe(0);
    expect(r.ambiguos).toBe(1);
    expect(db.gasto.every((g) => g.conciliado !== true)).toBe(true);
    expect(db.movimiento_bancario[0].gasto_id ?? null).toBeNull();
  });

  it('TC implícito: con UN solo gasto USD plausible sí liga', async () => {
    const db = mundo({
      gasto: [gastoBase('g-usd', 100, { moneda: 'USD', lugar: 'ASA Cancún' })],
    });
    const svc = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [cargo('2026-09-08', 2000, { descripcion: 'ASA CANCUN' })],
      },
      USER,
    )) as Record<string, unknown>;
    expect(r.conciliados).toBe(1);
    expect((r.por_criterio as Record<string, number>).TC_IMPLICITO).toBe(1);
  });

  it('sin moneda de la cuenta NO se cruza nada (jamás mezcla divisas)', async () => {
    // Si la cuenta no se puede leer, la consulta de candidatos no filtraría
    // divisa: un gasto de 125.82 USD cuadraría con un cargo de 125.82 MXN.
    const db = mundo({
      gasto: [gastoBase('g-usd', 125.82, { moneda: 'USD' })],
    });
    const svc = armar(db, { 'cuenta_bancaria:select': { message: 'caída' } });
    const r = (await svc.importar(
      { cuenta_bancaria_id: CTA, movimientos: [cargo('2026-09-08', 125.82)] },
      USER,
    )) as Record<string, unknown>;
    expect(r.conciliados).toBe(0);
    expect(r.errores).toBe(1);
    expect(db.gasto[0].conciliado).toBe(false);
    expect((r.detalle as Array<{ motivo: string }>)[0].motivo).toContain(
      'moneda',
    );
  });

  it('auto-match DIRIGIDO: con movimiento_ids la ventana de fechas no aplica', async () => {
    const db = mundo({
      gasto: [
        gastoBase('g-viejo', 125.82, {
          fecha_gasto: '2020-01-02',
          lugar: 'Aeropuerto de Cozumel',
        }),
      ],
      movimiento_bancario: [
        {
          id: 'm-viejo',
          cuenta_bancaria_id: CTA,
          fecha: '2020-01-02',
          tipo: TipoMovimientoBancario.CARGO,
          monto: 125.82,
          descripcion: 'AEROPUERTO DE COZUMEL',
          referencia: null,
          conciliado: false,
          gasto_id: null,
          notas: null,
        },
      ],
    });
    const svc = armar(db);
    const r = await svc.autoMatchPendientes(
      { movimiento_ids: ['m-viejo'] },
      USER,
    );
    expect(r.revisados).toBe(1);
    expect(r.conciliados).toBe(1);
    expect(db.movimiento_bancario[0].gasto_id).toBe('g-viejo');
  });
});

/**
 * «¿POR QUÉ salen como pendiente?» — la pregunta literal del cliente. La
 * lista anota el motivo con las MISMAS reglas del auto-cruce.
 */
describe('list — motivo de cada pendiente', () => {
  const movPendiente = (id: string, monto: number, extra: Row = {}): Row => ({
    id,
    cuenta_bancaria_id: CTA,
    fecha: '2026-09-08',
    tipo: TipoMovimientoBancario.CARGO,
    monto,
    descripcion: null,
    referencia: null,
    conciliado: false,
    gasto_id: null,
    notas: null,
    ...extra,
  });

  it('sin ningún gasto que cuadre: SIN_CANDIDATOS', async () => {
    const db = mundo({ movimiento_bancario: [movPendiente('m-1', 999.99)] });
    const svc = armar(db);
    const { data } = await svc.list({ limit: 100, offset: 0 });
    expect(data[0].motivo_pendiente).toBe('SIN_CANDIDATOS');
    expect(data[0].candidatos_n).toBe(0);
  });

  it('dos gastos iguales sin desempate: AMBIGUO con su conteo', async () => {
    const db = mundo({
      movimiento_bancario: [
        movPendiente('m-1', 125.82, { descripcion: 'AEROPUERTO DE COZUMEL' }),
      ],
      gasto: [
        gastoBase('g-a', 125.82, { lugar: 'Aeropuerto de Cozumel' }),
        gastoBase('g-b', 125.82, { lugar: 'Aeropuerto de Cozumel' }),
      ],
    });
    const svc = armar(db);
    const { data } = await svc.list({ limit: 100, offset: 0 });
    expect(data[0].motivo_pendiente).toBe('AMBIGUO');
    expect(data[0].candidatos_n).toBe(2);
  });

  it('un gasto que cuadra y nadie lo ligó: SE_PUEDE_CRUZAR', async () => {
    const db = mundo({
      movimiento_bancario: [movPendiente('m-1', 125.82)],
      gasto: [gastoBase('g-a', 125.82)],
    });
    const svc = armar(db);
    const { data } = await svc.list({ limit: 100, offset: 0 });
    expect(data[0].motivo_pendiente).toBe('SE_PUEDE_CRUZAR');
    expect(data[0].candidatos_n).toBe(1);
  });

  it('un movimiento YA conciliado no se anota', async () => {
    const db = mundo({
      movimiento_bancario: [
        movPendiente('m-1', 125.82, { conciliado: true, gasto_id: 'g-a' }),
      ],
      gasto: [gastoBase('g-a', 125.82, { conciliado: true })],
    });
    const svc = armar(db);
    const { data } = await svc.list({ limit: 100, offset: 0 });
    expect(data[0].motivo_pendiente).toBeUndefined();
  });

  it('si la lectura de gastos falla, la lista sale igual que siempre', async () => {
    const db = mundo({ movimiento_bancario: [movPendiente('m-1', 125.82)] });
    const svc = armar(db, { 'gasto:select': { message: 'boom' } });
    const { data } = await svc.list({ limit: 100, offset: 0 });
    expect(data).toHaveLength(1);
    expect(data[0].motivo_pendiente).toBeUndefined();
  });
});
