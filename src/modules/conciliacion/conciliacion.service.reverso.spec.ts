import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { rpcPartes, sembrarPartes } from './conciliacion-partes.fixture-spec';

/**
 * REVERSOS (30-sep-2026): «¿Cómo puedo conciliar los cargos reembolsados?».
 * Caso REAL de prod (GASTOS GNRAL): el 21-sep 8 cargos «ASUR CANCUN»
 * $825.13 (1 ya con su gasto) y el 23-sep 7 abonos «CARGO INDEBIDO 21 SEP
 * 355xx» de $825.13. Un cargo devuelto y su devolución se ANULAN: no son
 * gasto ni ingreso. Se congela:
 * - emparejar a mano (en los dos sentidos), idempotencia, 409 legibles y la
 *   compensación si el segundo update falla;
 * - quitar el emparejamiento (desde cualquiera de los dos, también con
 *   «Quitar clasificación») deja AMBOS pendientes y limpia solo sus notas;
 * - que gasto/cobro/clasificación no rompan un par (409);
 * - candidatos del diálogo y el emparejado automático con el caso real;
 * - la integración con «Cruzar pendientes» y la importación (criterio
 *   REVERSO, `reversos`/`reversos_emparejados`) SIN quitarle su cargo a un
 *   gasto;
 * - los aditivos de la lista y el «Conciliado con» del reporte;
 * - y que SIN la migración todo responda como hoy (503 en lo nuevo).
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = '76a931e0-7c06-47c6-a574-6c7d4a698c14';
const CTA_OTRA = 'cta-otra';
const USER = 'user-1';
const CL_REVERSO = 'cl-reverso';

const txt = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v == null
        ? ''
        : JSON.stringify(v);

const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

interface OpcionesFake {
  /** La migración 20260930000001 NO está: todo lo que nombre `reverso_de_id` ⇒ 42703. */
  sinReverso?: boolean;
  /** Error inyectado en un UPDATE (simula el trigger / la BD). */
  alActualizar?: (
    tabla: string,
    filas: Row[],
    patch: Row,
  ) => { code: string; message: string } | null;
}

/** Mini-PostgREST en memoria con escrituras y bitácora de consultas. */
function fakeSupabase(db: Tablas, opts: OpcionesFake = {}) {
  const log: Array<{ tabla: string; texto: string; op: string }> = [];
  let seq = 0;
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row = {};
      let aInsertar: Row[] = [];
      let rango: [number, number] | null = null;
      let limite: number | null = null;
      const orden: Array<[string, boolean]> = [];
      const entrada = { tabla, texto: '', op: 'select' };
      log.push(entrada);
      const marcar = (t: string) => {
        entrada.texto += ` ${t}`;
      };
      const ejecutar = (unico: boolean) => {
        entrada.op = op;
        if (opts.sinReverso && /reverso_de_id/.test(entrada.texto)) {
          return {
            data: null,
            error: {
              code: '42703',
              message:
                'column movimiento_bancario.reverso_de_id does not exist',
            },
            count: null,
          };
        }
        if (op === 'insert') {
          // Defaults de la columna (como en la BD) para movimiento_bancario.
          const defaults: Row =
            tabla === 'movimiento_bancario'
              ? {
                  conciliado: false,
                  gasto_id: null,
                  cobro_id: null,
                  cobro_grupo_id: null,
                  clasificacion_id: null,
                  ingreso_id: null,
                  reverso_de_id: null,
                  gastos_n: 0,
                  notas: null,
                  created_at: `2026-09-30T00:00:0${seq}Z`,
                }
              : {};
          const creados = aInsertar.map((r) => ({
            id: `${tabla}-${++seq}`,
            ...defaults,
            ...r,
          }));
          db[tabla] = [...(db[tabla] ?? []), ...creados];
          return {
            data: unico ? (creados[0] ?? null) : creados,
            error: null,
            count: creados.length,
          };
        }
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        if (op === 'update') {
          const err = opts.alActualizar?.(tabla, filas, patch) ?? null;
          if (err) return { data: null, error: err, count: null };
          // Índice ÚNICO uq_mov_bancario_reverso_de.
          if (
            tabla === 'movimiento_bancario' &&
            typeof patch.reverso_de_id === 'string'
          ) {
            const ocupado = (db[tabla] ?? []).some(
              (r) =>
                r.reverso_de_id === patch.reverso_de_id && !filas.includes(r),
            );
            if (ocupado) {
              return {
                data: null,
                error: {
                  code: '23505',
                  message:
                    'duplicate key value violates unique constraint "uq_mov_bancario_reverso_de"',
                },
                count: null,
              };
            }
          }
          filas.forEach((r) => Object.assign(r, patch));
        }
        if (op === 'delete') {
          db[tabla] = (db[tabla] ?? []).filter((r) => !filas.includes(r));
        }
        let out = filas.map((r) => ({ ...r }));
        for (const [col, asc] of [...orden].reverse()) {
          out.sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        const total = out.length;
        if (rango) out = out.slice(rango[0], rango[1] + 1);
        if (limite != null) out = out.slice(0, limite);
        return {
          data: unico ? (out[0] ?? null) : out,
          error: null,
          count: total,
        };
      };
      const api: Record<string, unknown> = {
        select(s?: string) {
          marcar(`select(${s ?? ''})`);
          return api;
        },
        insert(r: Row | Row[]) {
          op = 'insert';
          aInsertar = Array.isArray(r) ? r : [r];
          marcar(JSON.stringify(Object.keys(aInsertar[0] ?? {})));
          return api;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
          marcar(`update(${JSON.stringify(Object.keys(p))})`);
          return api;
        },
        delete() {
          op = 'delete';
          return api;
        },
        eq(col: string, val: unknown) {
          marcar(`eq:${col}`);
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          marcar(`neq:${col}`);
          filtros.push((r) => r[col] !== val);
          return api;
        },
        is(col: string, val: unknown) {
          marcar(`is:${col}`);
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        not(col: string, o: string, val: unknown) {
          marcar(`not:${col}`);
          if (o === 'is' && val === null) {
            filtros.push((r) => (r[col] ?? null) !== null);
          }
          return api;
        },
        ilike(col: string, val: string) {
          filtros.push((r) => txt(r[col]).toLowerCase() === val.toLowerCase());
          return api;
        },
        in(col: string, vals: unknown[]) {
          marcar(`in:${col}`);
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        or(cond: string) {
          marcar(`or:${cond}`);
          return api;
        },
        gte(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) >= 0);
          return api;
        },
        lte(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) <= 0);
          return api;
        },
        gt(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) > 0);
          return api;
        },
        lt(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) < 0);
          return api;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orden.push([col, o?.ascending !== false]);
          return api;
        },
        range(a: number, b: number) {
          rango = [a, b];
          return api;
        },
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
    // RPC de la puente (migración 20261002000002) emulada en memoria.
    rpc: (nombre: string, args: Row) => {
      log.push({ tabla: `rpc:${nombre}`, texto: '', op: 'rpc' });
      return Promise.resolve(rpcPartes(db, nombre, args));
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

const mov = (id: string, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-21',
  tipo: 'CARGO',
  monto: 825.13,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'ASUR CANCUN',
  referencia: null,
  notas: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  reverso_de_id: null,
  origen: 'IMPORTADO',
  created_at: '2026-09-22 21:31:37.675974+00',
  ...extra,
});

/** Los 8 cargos REALES del 21-sep: el último ya tiene su gasto. */
const CARGOS_IDS = [
  '9d022c9a-c191-427b-94a7-b4e6d2f9e2f3',
  '4083e656-3204-424c-956b-0cc3d77d0b5d',
  '5f45d94d-00bf-44ae-8cdc-fed1f57686a4',
  '466f49f9-c8d6-4a3c-8e33-1a629471836b',
  '2baee742-cf9f-460a-8032-2ed9d6917d6d',
  'dbc329cf-7102-4141-a1db-1c1adbb0c44a',
  '5196a770-b25a-4fdd-b093-b4b1a9c28115',
];
const CARGO_CON_GASTO = '1263ca78-21d8-4c70-8009-6c0f311f37d7';
const ABONOS: Array<[string, string]> = [
  ['405466de-599b-4c0e-b2df-203133282530', '35552'],
  ['35d5c5eb-ebf6-4959-a22a-e5282cde329d', '35554'],
  ['e9eae31a-8fbb-49ac-a156-f3b62b808212', '35555'],
  ['c377b91a-b0dd-46e5-92a1-1d5267ed1007', '35564'],
  ['db3c10e9-f67f-4c7c-a238-83d44a8f3f3b', '35572'],
  ['52249ccb-76a7-4634-8bfb-1ccf784667fd', '35578'],
  ['eb3467a3-7d15-4a73-8ac5-7010dde4ec39', '35579'],
];
const ABONO_1 = ABONOS[0][0];
const CARGO_1 = CARGOS_IDS[0];

function casoReal(): Row[] {
  return [
    ...CARGOS_IDS.map((id) => mov(id)),
    mov(CARGO_CON_GASTO, { conciliado: true, gasto_id: 'g-asur' }),
    ...ABONOS.map(([id, n]) =>
      mov(id, {
        tipo: 'ABONO',
        fecha: '2026-09-23',
        descripcion: `CARGO INDEBIDO 21 SEP ${n}`,
        referencia: '00000000001303268115',
        created_at: '2026-09-29 20:20:37.125835+00',
      }),
    ),
  ];
}

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'GASTOS GNRAL',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
      {
        id: CTA_OTRA,
        alias: 'HSBC',
        banco: 'HSBC',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
    ],
    tarjeta_corporativa: [],
    conciliacion_clasificacion: [
      { id: 'cl-traspaso', nombre: 'Traspaso entre cuentas', activo: true },
      { id: CL_REVERSO, nombre: 'Reverso de un cargo', activo: true },
    ],
    movimiento_bancario: casoReal(),
    gasto: [],
    cobro_vuelo: [],
    cobro_grupo: [],
    ingreso: [],
    cliente: [],
    estado_cuenta_archivo: [],
    ...extra,
  };
}

function armar(db: Tablas, opts: OpcionesFake = {}) {
  sembrarPartes(db);
  const f = fakeSupabase(db, opts);
  const generateTablaXlsx = jest.fn().mockResolvedValue(Buffer.from('xlsx'));
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    { generateTablaXlsx } as unknown as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, log: f.log, generateTablaXlsx };
}

const fila = (db: Tablas, id: string) =>
  db.movimiento_bancario.find((m) => m.id === id)!;

const error = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!e) throw new Error('se esperaba un error');
  const r = (e as { getResponse?: () => unknown }).getResponse?.() as
    | { error?: string; message?: string; details?: Row }
    | undefined;
  return { e, code: r?.error, message: r?.message, details: r?.details };
};

// =====================================================================
describe('emparejarReverso — a mano', () => {
  it('abono + cargo ⇒ los DOS conciliados con «Reverso de un cargo» y notas que nombran al otro', async () => {
    const { svc, db } = armar(mundo());
    fila(db, ABONO_1).notas = 'Aclaración 88 con el banco';
    const r = await svc.emparejarReverso(ABONO_1, CARGO_1, USER);

    expect(fila(db, ABONO_1)).toMatchObject({
      reverso_de_id: CARGO_1,
      clasificacion_id: CL_REVERSO,
      conciliado: true,
      gasto_id: null,
      cobro_id: null,
      cobro_grupo_id: null,
      ingreso_id: null,
      notas:
        'Devuelve el cargo del 21-09 · ASUR CANCUN\nAclaración 88 con el banco',
      updated_by: USER,
    });
    expect(fila(db, CARGO_1)).toMatchObject({
      clasificacion_id: CL_REVERSO,
      conciliado: true,
      gasto_id: null,
      reverso_de_id: null,
      notas: 'Devuelto el 23-09 · CARGO INDEBIDO 21 SEP 35552',
    });
    expect(r.idempotente).toBe(false);
    expect(r.abono.reverso_de).toEqual({
      id: CARGO_1,
      fecha: '2026-09-21',
      descripcion: 'ASUR CANCUN',
    });
    expect(r.cargo?.revertido_por).toEqual({
      id: ABONO_1,
      fecha: '2026-09-23',
      descripcion: 'CARGO INDEBIDO 21 SEP 35552',
    });
    // No creó otra clasificación: usó la existente.
    expect(db.conciliacion_clasificacion).toHaveLength(2);
  });

  it('también desde el CARGO (el rol sale del tipo)', async () => {
    const { svc, db } = armar(mundo());
    await svc.emparejarReverso(CARGO_1, ABONO_1, USER);
    expect(fila(db, ABONO_1).reverso_de_id).toBe(CARGO_1);
    expect(fila(db, CARGO_1).conciliado).toBe(true);
  });

  it('reintento del MISMO par ⇒ 200 idempotente sin escribir', async () => {
    const { svc, db, log } = armar(mundo());
    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    const antes = log.filter((q) => q.op === 'update').length;
    const r = await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    expect(r.idempotente).toBe(true);
    expect(log.filter((q) => q.op === 'update').length).toBe(antes);
    expect(fila(db, ABONO_1).notas).toBe(
      'Devuelve el cargo del 21-09 · ASUR CANCUN',
    );
  });

  it('crea la clasificación si falta y la REACTIVA si estaba de baja', async () => {
    const sin = armar(mundo({ conciliacion_clasificacion: [] }));
    await sin.svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    expect(sin.db.conciliacion_clasificacion).toEqual([
      expect.objectContaining({ nombre: 'Reverso de un cargo' }),
    ]);
    expect(fila(sin.db, ABONO_1).clasificacion_id).toBe(
      sin.db.conciliacion_clasificacion[0].id,
    );

    const baja = armar(
      mundo({
        conciliacion_clasificacion: [
          { id: 'cl-x', nombre: 'reverso de un CARGO', activo: false },
        ],
      }),
    );
    await baja.svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    expect(baja.db.conciliacion_clasificacion).toEqual([
      { id: 'cl-x', nombre: 'reverso de un CARGO', activo: true },
    ]);
    expect(fila(baja.db, CARGO_1).clasificacion_id).toBe('cl-x');
  });

  it.each([
    [
      'cargo ligado a un GASTO',
      CARGO_CON_GASTO,
      'El cargo ya está conciliado con un gasto: quítalo antes.',
    ],
    [
      'dos abonos',
      ABONOS[1][0],
      'Se empareja un CARGO con el ABONO que lo devuelve (los dos son ABONO).',
    ],
  ])('409 REVERSO_INVALIDO: %s', async (_n, otro, motivo) => {
    const { svc, db } = armar(mundo());
    const r = await error(svc.emparejarReverso(ABONO_1, otro, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('REVERSO_INVALIDO');
    expect(r.message).toBe(motivo);
    expect(r.details?.motivo).toBe(motivo);
    expect(fila(db, ABONO_1).conciliado).toBe(false);
  });

  it('409: otra cuenta, otro monto, cargo ya devuelto por otro abono', async () => {
    const db = mundo();
    db.movimiento_bancario.push(
      mov('c-otra', { cuenta_bancaria_id: CTA_OTRA }),
      mov('c-monto', { monto: 900 }),
    );
    const { svc } = armar(db);
    expect(
      (await error(svc.emparejarReverso(ABONO_1, 'c-otra', USER))).message,
    ).toBe('El cargo y su devolución deben ser de la misma cuenta bancaria.');
    expect(
      (await error(svc.emparejarReverso(ABONO_1, 'c-monto', USER))).message,
    ).toBe('Los montos no coinciden (cargo $900.00, devolución $825.13).');

    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    const r = await error(svc.emparejarReverso(ABONOS[1][0], CARGO_1, USER));
    expect(r.code).toBe('REVERSO_INVALIDO');
    // El cargo ya está conciliado (con su devolución): no se lo lleva otro.
    expect(r.message).toMatch(/ya tiene su devolución|ya está conciliado/);
  });

  it('404 si alguno no existe; 400 sin cargo_id', async () => {
    const { svc } = armar(mundo());
    const r = await error(svc.emparejarReverso(ABONO_1, 'no-existe', USER));
    expect(r.e).toBeInstanceOf(NotFoundException);
    expect(r.code).toBe('MOVIMIENTO_NO_EXISTE');
    expect((await error(svc.emparejarReverso(ABONO_1, null, USER))).code).toBe(
      'REVERSO_SIN_PAR',
    );
  });

  it('el rechazo del TRIGGER llega como 409 con su motivo', async () => {
    const { svc, db } = armar(mundo(), {
      alActualizar: (tabla, _f, patch) =>
        tabla === 'movimiento_bancario' && patch.reverso_de_id
          ? {
              code: '23514',
              message:
                'REVERSO_INVALIDO: el cargo ya está conciliado con un gasto, cobro o ingreso',
            }
          : null,
    });
    const r = await error(svc.emparejarReverso(ABONO_1, CARGO_1, USER));
    expect(r.code).toBe('REVERSO_INVALIDO');
    expect(r.message).toBe(
      'el cargo ya está conciliado con un gasto, cobro o ingreso',
    );
    expect(fila(db, ABONO_1).conciliado).toBe(false);
  });

  it('si el CARGO no se puede escribir, el abono se REGRESA a pendiente (compensación)', async () => {
    const { svc, db } = armar(mundo(), {
      alActualizar: (tabla, filas, patch) =>
        tabla === 'movimiento_bancario' &&
        filas.some((f) => f.id === CARGO_1) &&
        patch.conciliado === true
          ? { code: '08006', message: 'conexión perdida' }
          : null,
    });
    fila(db, ABONO_1).notas = 'nota de la oficina';
    await expect(svc.emparejarReverso(ABONO_1, CARGO_1, USER)).rejects.toThrow(
      'conexión perdida',
    );
    expect(fila(db, ABONO_1)).toMatchObject({
      reverso_de_id: null,
      clasificacion_id: null,
      conciliado: false,
      notas: 'nota de la oficina',
    });
    expect(fila(db, CARGO_1).conciliado).toBe(false);
  });
});

describe('desemparejarReverso / «Quitar clasificación»', () => {
  it('desde el CARGO: los DOS vuelven a pendiente y solo se quitan los renglones del emparejado', async () => {
    const { svc, db } = armar(mundo());
    fila(db, ABONO_1).notas = 'Aclaración 88';
    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    const r = await svc.desemparejarReverso(CARGO_1, USER);
    expect(fila(db, ABONO_1)).toMatchObject({
      reverso_de_id: null,
      clasificacion_id: null,
      conciliado: false,
      notas: 'Aclaración 88',
    });
    expect(fila(db, CARGO_1)).toMatchObject({
      clasificacion_id: null,
      conciliado: false,
      notas: null,
    });
    expect(r.abono.reverso_de).toBeNull();
    expect(r.cargo?.revertido_por).toBeNull();
  });

  it('404 SIN_REVERSO si no está emparejado', async () => {
    const { svc } = armar(mundo());
    const r = await error(svc.desemparejarReverso(ABONO_1, USER));
    expect(r.code).toBe('SIN_REVERSO');
  });

  it('«Quitar clasificación» (null) en CUALQUIERA de los dos desempareja AMBOS', async () => {
    const { svc, db } = armar(mundo());
    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    const r = await svc.clasificarMovimiento(ABONO_1, null, undefined, USER);
    expect(r).toMatchObject({ id: ABONO_1, desemparejado_con: CARGO_1 });
    expect(fila(db, ABONO_1).conciliado).toBe(false);
    expect(fila(db, CARGO_1).conciliado).toBe(false);
    expect(fila(db, CARGO_1).clasificacion_id).toBeNull();
  });

  it('cambiar la clasificación de un par ⇒ 409; la MISMA (editar notas) sí', async () => {
    const { svc, db } = armar(mundo());
    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    const r = await error(
      svc.clasificarMovimiento(CARGO_1, 'cl-traspaso', undefined, USER),
    );
    expect(r.code).toBe('MOVIMIENTO_EN_REVERSO');
    expect(r.details).toEqual({ abono_id: ABONO_1, cargo_id: CARGO_1 });
    await svc.clasificarMovimiento(CARGO_1, CL_REVERSO, 'Visto con Mary', USER);
    expect(fila(db, CARGO_1)).toMatchObject({
      clasificacion_id: CL_REVERSO,
      conciliado: true,
      notas: 'Visto con Mary',
    });
    expect(fila(db, ABONO_1).reverso_de_id).toBe(CARGO_1);
  });

  it('ligar/desligar un gasto o un cobro sobre un par ⇒ 409 MOVIMIENTO_EN_REVERSO', async () => {
    const { svc, db } = armar(mundo());
    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    expect((await error(svc.link(CARGO_1, 'g-1', USER))).code).toBe(
      'MOVIMIENTO_EN_REVERSO',
    );
    expect((await error(svc.link(CARGO_1, null, USER))).code).toBe(
      'MOVIMIENTO_EN_REVERSO',
    );
    expect(
      (
        await error(
          svc.linkCobro(
            ABONO_1,
            { cobro_id: 'c-1', cobro_grupo_id: null },
            USER,
          ),
        )
      ).code,
    ).toBe('MOVIMIENTO_EN_REVERSO');
    expect(fila(db, CARGO_1).gasto_id).toBeNull();
  });
});

describe('candidatosReverso — el diálogo', () => {
  it('desde el ABONO: los 7 cargos pendientes (NO el del gasto), un solo sugerido', async () => {
    const { svc } = armar(mundo());
    const c = await svc.candidatosReverso(ABONO_1);
    expect(c.map((x) => x.id).sort()).toEqual([...CARGOS_IDS].sort());
    expect(c.every((x) => x.tipo === 'CARGO' && x.monto === 825.13)).toBe(true);
    expect(c.filter((x) => x.sugerido)).toHaveLength(1);
    expect(c[0]).toEqual(
      expect.objectContaining({
        fecha: '2026-09-21',
        descripcion: 'ASUR CANCUN',
        es_devolucion: false,
      }),
    );
  });

  it('fecha desc y ventana de 60 días hacia atrás', async () => {
    const db = mundo();
    db.movimiento_bancario.push(
      mov('c-ago', { fecha: '2026-08-01' }),
      mov('c-jul', { fecha: '2026-07-20' }),
      mov('c-despues', { fecha: '2026-09-24' }),
    );
    const { svc } = armar(db);
    const c = await svc.candidatosReverso(ABONO_1);
    expect(c.map((x) => x.id)).toContain('c-ago');
    expect(c.map((x) => x.id)).not.toContain('c-jul');
    expect(c.map((x) => x.id)).not.toContain('c-despues');
    expect(c[c.length - 1].id).toBe('c-ago');
  });

  it('desde el CARGO («Lo devolvió el banco»): devoluciones primero', async () => {
    const db = mundo();
    db.movimiento_bancario.push(
      mov('spei', {
        tipo: 'ABONO',
        fecha: '2026-09-22',
        descripcion: 'SPEI RECIBIDO JUAN PEREZ',
      }),
    );
    const { svc } = armar(db);
    const c = await svc.candidatosReverso(CARGO_1);
    expect(c).toHaveLength(8);
    expect(c[c.length - 1].id).toBe('spei');
    expect(c.slice(0, 7).every((x) => x.es_devolucion)).toBe(true);
    expect(c.filter((x) => x.sugerido)).toHaveLength(1);
    expect(c.find((x) => x.sugerido)?.es_devolucion).toBe(true);
  });

  it('sin candidatos ⇒ []; movimiento ya conciliado ⇒ 409', async () => {
    const db = mundo();
    db.movimiento_bancario.push(
      mov('solo', { tipo: 'ABONO', fecha: '2026-09-23', monto: 1.23 }),
    );
    const { svc } = armar(db);
    await expect(svc.candidatosReverso('solo')).resolves.toEqual([]);
    expect((await error(svc.candidatosReverso(CARGO_CON_GASTO))).code).toBe(
      'MOVIMIENTO_YA_LIGADO',
    );
  });
});

describe('autoReversos — «Emparejar devoluciones» con el CASO REAL', () => {
  it('empareja las 7 devoluciones con 7 cargos distintos y JAMÁS toca el del gasto', async () => {
    const { svc, db } = armar(mundo());
    const r = await svc.autoReversos(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(r).toMatchObject({
      revisados: 7,
      emparejados: 7,
      sin_candidato: 0,
      ambiguos: 0,
      errores: 0,
    });
    const cargos = ABONOS.map(([id]) => fila(db, id).reverso_de_id as string);
    expect(new Set(cargos).size).toBe(7);
    expect([...cargos].sort()).toEqual([...CARGOS_IDS].sort());
    for (const id of [...CARGOS_IDS, ...ABONOS.map(([a]) => a)]) {
      expect(fila(db, id)).toMatchObject({
        conciliado: true,
        clasificacion_id: CL_REVERSO,
      });
    }
    expect(fila(db, CARGO_CON_GASTO)).toMatchObject({
      gasto_id: 'g-asur',
      clasificacion_id: null,
      notas: null,
    });
    expect(r.detalle[0]).toMatchObject({
      resultado: 'EMPAREJADO',
      abono_fecha: '2026-09-23',
      cargo_fecha: '2026-09-21',
      cargo_descripcion: 'ASUR CANCUN',
      pista_fecha: '2026-09-21',
    });
    // Segunda corrida: ya no hay nada pendiente.
    const r2 = await svc.autoReversos({}, USER);
    expect(r2.revisados).toBe(0);
  });

  it('respeta la cuenta y deja pendiente lo AMBIGUO', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov('c1', { fecha: '2026-09-05' }),
        mov('c2', { fecha: '2026-09-12' }),
        mov('dev', {
          tipo: 'ABONO',
          fecha: '2026-09-20',
          descripcion: 'DEVOLUCION TPV',
        }),
        mov('dev-otra', {
          tipo: 'ABONO',
          fecha: '2026-09-20',
          descripcion: 'DEVOLUCION TPV',
          cuenta_bancaria_id: CTA_OTRA,
        }),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.autoReversos(
      { cuenta_bancaria_id: CTA, desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(r).toMatchObject({ revisados: 1, emparejados: 0, ambiguos: 1 });
    expect(r.detalle[0].motivo).toContain('fechas distintas (05-09, 12-09)');
    expect(fila(db, 'dev').conciliado).toBe(false);
  });
});

describe('«Cruzar pendientes» e importación — criterio REVERSO', () => {
  const gastoAsur = (): Row => ({
    id: 'g-nuevo',
    monto: 825.13,
    moneda: 'MXN',
    fecha_gasto: '2026-09-21',
    medio_pago: 'TARJETA_CORP',
    conciliado: false,
    tc_gasto: null,
    tarjeta_terminacion: null,
    lugar: 'Aeropuerto de Cancún',
    notas: null,
    categoria: 'TUAS',
    vuelo_id: null,
    proveedor_id: null,
  });

  it('el GASTO se lleva su cargo primero; las 7 devoluciones, los otros 7', async () => {
    const db = mundo({
      gasto: [gastoAsur()],
      movimiento_bancario: casoReal().map((m) =>
        m.id === CARGO_CON_GASTO
          ? { ...m, conciliado: false, gasto_id: null }
          : m,
      ),
    });
    const { svc } = armar(db);
    const r = await svc.autoMatchPendientes(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(r.revisados).toBe(15);
    expect(r.conciliados).toBe(1);
    expect(r.reversos).toBe(14);
    expect(r.reversos_emparejados).toBe(7);
    expect(r.por_criterio.REVERSO).toBe(14);
    expect(r.sin_candidato + r.ambiguos + r.errores).toBe(0);
    const conGasto = db.movimiento_bancario.filter((m) => m.gasto_id);
    expect(conGasto).toHaveLength(1);
    expect(conGasto[0].clasificacion_id).toBeNull();
    expect(db.movimiento_bancario.every((m) => m.conciliado === true)).toBe(
      true,
    );
    const abono = r.detalle.find((d) => d.movimiento_id === ABONO_1);
    expect(abono).toMatchObject({
      resultado: 'REVERSO',
      criterio: 'REVERSO',
    });
    expect(abono?.motivo).toMatch(
      /^Devuelve el cargo del 21-09 · ASUR CANCUN\.$/,
    );
  });

  it('una devolución SIN cargo dice por qué en el detalle', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov('dev', {
          tipo: 'ABONO',
          fecha: '2026-09-23',
          descripcion: 'CARGO INDEBIDO 21 SEP 1',
        }),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.autoMatchPendientes(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(r.reversos).toBe(0);
    expect(r.detalle[0]).toMatchObject({
      resultado: 'SIN_CANDIDATO',
      motivo:
        'Devolución de un cargo: El banco indica un cargo del 21-09 y no hay uno pendiente por $825.13 en esa fecha.',
    });
  });

  it('la IMPORTACIÓN empareja el cargo y su devolución del mismo estado de cuenta', async () => {
    const db = mundo({ movimiento_bancario: [] });
    const { svc } = armar(db);
    const r = (await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          {
            fecha: '2026-09-21',
            tipo: 'CARGO',
            monto: 825.13,
            descripcion: 'ASUR CANCUN',
          },
          {
            fecha: '2026-09-23',
            tipo: 'ABONO',
            monto: 825.13,
            descripcion: 'CARGO INDEBIDO 21 SEP 35552',
          },
        ],
      } as never,
      USER,
    )) as Record<string, unknown>;
    expect(r.importados).toBe(2);
    expect(r.reversos).toBe(2);
    expect(r.reversos_emparejados).toBe(1);
    expect(r.conciliados_auto).toBe(2);
    const [c, a] = db.movimiento_bancario;
    expect(a.reverso_de_id).toBe(c.id);
    expect(c.conciliado).toBe(true);
  });
});

describe('lectores: lista y reporte', () => {
  it('GET movimientos: `reverso_de` en el abono y `revertido_por` en el cargo', async () => {
    const { svc } = armar(mundo());
    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    const r = await svc.list({
      cuenta_bancaria_id: CTA,
      limit: 50,
      offset: 0,
    });
    const porId = new Map(r.data.map((m) => [m.id, m]));
    expect(porId.get(ABONO_1)).toMatchObject({
      reverso_de_id: CARGO_1,
      reverso_de: {
        id: CARGO_1,
        fecha: '2026-09-21',
        descripcion: 'ASUR CANCUN',
      },
      revertido_por: null,
    });
    expect(porId.get(CARGO_1)).toMatchObject({
      reverso_de: null,
      revertido_por: {
        id: ABONO_1,
        fecha: '2026-09-23',
        descripcion: 'CARGO INDEBIDO 21 SEP 35552',
      },
    });
    expect(porId.get(CARGO_CON_GASTO)).toMatchObject({
      reverso_de: null,
      revertido_por: null,
    });
  });

  it('reporte: «Conciliado con» nombra al otro del par', async () => {
    const db = mundo();
    db.movimiento_bancario = db.movimiento_bancario.map((m) => ({
      ...m,
      clasificacion: null,
    }));
    const { svc, generateTablaXlsx } = armar(db);
    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    // El embed de la clasificación lo resuelve PostgREST; aquí se simula.
    for (const id of [ABONO_1, CARGO_1]) {
      fila(db, id).clasificacion = { nombre: 'Reverso de un cargo' };
    }
    await svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    const llamadas = generateTablaXlsx.mock.calls as unknown as Array<
      [{ filas: unknown[][] }]
    >;
    const payload = llamadas[0][0];
    const conQue = new Map(
      payload.filas.map((f) => [`${String(f[0])}|${String(f[1])}`, f[7]]),
    );
    expect(conQue.get('2026-09-23|CARGO INDEBIDO 21 SEP 35552')).toBe(
      'Reverso de un cargo · devuelve el cargo del 21-09 · ASUR CANCUN',
    );
    const cargosDel21 = payload.filas.filter(
      (f) =>
        f[7] ===
        'Reverso de un cargo · devuelto el 23-09 · CARGO INDEBIDO 21 SEP 35552',
    );
    expect(cargosDel21).toHaveLength(1);
    const estatus = payload.filas.filter((f) =>
      String(f[7]).startsWith('Reverso de un cargo'),
    );
    expect(estatus.every((f) => f[6] === 'Conciliado')).toBe(true);
  });
});

describe('Ingresos → «Por conciliar»: la devolución emparejada NO es ingreso', () => {
  it('el abono emparejado sale de la bandeja; los otros 6 siguen', async () => {
    const { svc } = armar(mundo());
    const antes = await svc.abonosPendientes({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(antes.data.map((a) => a.id)).toContain(ABONO_1);
    await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    const despues = await svc.abonosPendientes({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    const ids = despues.data.map((a) => a.id);
    expect(ids).not.toContain(ABONO_1);
    expect(ids).toHaveLength(6);
  });
});

describe('SIN la migración 20260930000001', () => {
  it('rutas nuevas ⇒ 503 REVERSOS_NO_DISPONIBLE', async () => {
    const { svc } = armar(mundo(), { sinReverso: true });
    for (const p of [
      svc.candidatosReverso(ABONO_1),
      svc.emparejarReverso(ABONO_1, CARGO_1, USER),
      svc.desemparejarReverso(ABONO_1, USER),
      svc.autoReversos({}, USER),
    ]) {
      const r = await error(p);
      expect(r.e).toBeInstanceOf(ServiceUnavailableException);
      expect(r.code).toBe('REVERSOS_NO_DISPONIBLE');
    }
  });

  it('lista, re-cruce, ligas y clasificación como HOY: ninguna consulta nombra la columna (salvo la sonda)', async () => {
    const db = mundo();
    const { svc, log } = armar(db, { sinReverso: true });
    const lista = await svc.list({
      cuenta_bancaria_id: CTA,
      limit: 50,
      offset: 0,
    });
    expect(lista.data.length).toBe(15);
    expect(lista.data[0]).toMatchObject({
      reverso_de: null,
      revertido_por: null,
    });
    const r = await svc.autoMatchPendientes(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(r.reversos).toBe(0);
    expect(r.reversos_emparejados).toBe(0);
    await svc.clasificarMovimiento(ABONO_1, CL_REVERSO, 'a mano', USER);
    expect(fila(db, ABONO_1)).toMatchObject({
      conciliado: true,
      clasificacion_id: CL_REVERSO,
    });
    await svc.link(CARGO_1, null, USER);
    const nombran = log.filter((q) => /reverso_de_id/.test(q.texto));
    // Solo la sonda (memorizada: una vez por cliente).
    expect(nombran).toHaveLength(1);
    expect(nombran[0].texto.trim()).toBe('select(reverso_de_id)');
  });
});

// =====================================================================
// Revisión adversaria (30-sep-2026).
describe('revisión adversaria — lo que NO debe emparejarse ni ligarse', () => {
  /** Lote REAL de prod (jul/ago): «Rev ASUR Merida» $110.82. */
  const loteMerida = (): Row[] => [
    ...[1, 2, 3, 4].map((n) =>
      mov(`m${n}`, {
        fecha: '2026-07-06',
        monto: 110.82,
        descripcion: 'ASUR Merida',
        created_at: `2026-07-07 10:00:0${n}+00`,
      }),
    ),
    mov('m-gasto', {
      fecha: '2026-08-07',
      monto: 110.82,
      descripcion: 'ASUR MERIDA',
      conciliado: true,
      gasto_id: 'g-merida',
    }),
    ...['r1', 'r2'].map((id) =>
      mov(id, {
        tipo: 'ABONO',
        fecha: '2026-07-06',
        monto: 110.82,
        descripcion: 'Rev ASUR Merida',
      }),
    ),
    mov('r3', {
      tipo: 'ABONO',
      fecha: '2026-08-07',
      monto: 110.82,
      descripcion: 'REV.ASUR MERIDA',
    }),
  ];

  it('«Emparejar devoluciones» con el lote REAL de «REV»: el del 07-08 (su cargo tiene gasto) NO se lleva un cargo del 06-07', async () => {
    const db = mundo({ movimiento_bancario: loteMerida() });
    const { svc } = armar(db);
    const r = await svc.autoReversos(
      { desde: '2026-07-01', hasta: '2026-08-31' },
      USER,
    );
    expect(r).toMatchObject({ revisados: 3, emparejados: 2, ambiguos: 1 });
    expect(fila(db, 'r3')).toMatchObject({
      conciliado: false,
      reverso_de_id: null,
      clasificacion_id: null,
    });
    // Quedan DOS cargos del 06-07 pendientes (los reales, para su gasto) y
    // el del gasto intacto.
    const pendientes06 = ['m1', 'm2', 'm3', 'm4'].filter(
      (id) => fila(db, id).conciliado === false,
    );
    expect(pendientes06).toHaveLength(2);
    expect(fila(db, 'm-gasto')).toMatchObject({
      gasto_id: 'g-merida',
      clasificacion_id: null,
    });
    const d3 = r.detalle.find((d) => d.abono_id === 'r3');
    expect(d3?.motivo).toContain('más reciente (07-08) ya está conciliado');
  });

  it('diálogo desde esa devolución: lista los libres del 06-07 pero NO sugiere ninguno', async () => {
    const db = mundo({ movimiento_bancario: loteMerida() });
    const { svc } = armar(db);
    const c = await svc.candidatosReverso('r3');
    expect(c.map((x) => x.id).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(c.some((x) => x.sugerido)).toBe(false);
    // El del gasto jamás sale en la lista.
    expect(c.find((x) => x.id === 'm-gasto')).toBeUndefined();
  });

  it('CAS completo: si el abono se ligó a un cobro entre la lectura y la escritura ⇒ 409 y el cobro NO se borra', async () => {
    const { svc, db, log } = armar(mundo());
    // Lectura «vieja» (libre) mientras en la BD ya tiene un cobro.
    const viejo = { ...fila(db, ABONO_1) };
    fila(db, ABONO_1).cobro_id = 'cobro-cliente';
    fila(db, ABONO_1).conciliado = false; // peor caso: sin la bandera
    const original = (
      svc as unknown as { leerMovReverso: (id: string) => Promise<unknown> }
    ).leerMovReverso.bind(svc);
    (
      svc as unknown as { leerMovReverso: (id: string) => Promise<unknown> }
    ).leerMovReverso = (id: string) =>
      id === ABONO_1
        ? Promise.resolve(
            (
              svc as unknown as { aMovReverso: (r: Row) => unknown }
            ).aMovReverso(viejo),
          )
        : original(id);
    const r = await error(svc.emparejarReverso(ABONO_1, CARGO_1, USER));
    expect(r.code).toBe('REVERSO_INVALIDO');
    expect(fila(db, ABONO_1)).toMatchObject({
      cobro_id: 'cobro-cliente',
      reverso_de_id: null,
    });
    expect(fila(db, CARGO_1).conciliado).toBe(false);
    const upd = log.find(
      (q) =>
        q.op === 'update' &&
        q.tabla === 'movimiento_bancario' &&
        q.texto.includes('reverso_de_id'),
    );
    for (const col of [
      'gasto_id',
      'cobro_id',
      'cobro_grupo_id',
      'clasificacion_id',
      'ingreso_id',
    ]) {
      expect(upd?.texto).toContain(`is:${col}`);
    }
  });

  it('par A MEDIAS (el cargo no se escribió): el reintento lo COMPLETA, no responde «idempotente»', async () => {
    const { svc, db } = armar(mundo());
    Object.assign(fila(db, ABONO_1), {
      reverso_de_id: CARGO_1,
      clasificacion_id: CL_REVERSO,
      conciliado: true,
      notas: 'Devuelve el cargo del 21-09 · ASUR CANCUN',
    });
    const r = await svc.emparejarReverso(ABONO_1, CARGO_1, USER);
    expect(r.idempotente).toBe(false);
    expect(fila(db, CARGO_1)).toMatchObject({
      conciliado: true,
      clasificacion_id: CL_REVERSO,
      notas: 'Devuelto el 23-09 · CARGO INDEBIDO 21 SEP 35552',
    });
    expect(r.cargo?.revertido_por).toMatchObject({ id: ABONO_1 });
    // Ya completo: ahora sí idempotente.
    expect(
      (await svc.emparejarReverso(ABONO_1, CARGO_1, USER)).idempotente,
    ).toBe(true);
  });

  const cobroCliente = (): Row => ({
    id: 'cobro-cliente',
    vuelo_id: 'v-1',
    monto: 825.13,
    moneda: 'MXN',
    metodo_cobro: 'TRANSFERENCIA',
    fecha_cobro: '2026-09-22T17:00:00Z',
    referencia: null,
    comision_banco_monto: null,
    cobro_grupo_id: null,
    ingreso_anticipo_id: null,
    vuelo: { folio: 1, cliente: { nombre: 'Cliente Uno' } },
  });

  it('«Cruzar pendientes»: una DEVOLUCIÓN jamás se liga por monto al cobro de un cliente; se empareja con su cargo', async () => {
    const db = mundo({
      cobro_vuelo: [cobroCliente()],
      movimiento_bancario: [
        mov('c21'),
        mov('dev', {
          tipo: 'ABONO',
          fecha: '2026-09-23',
          descripcion: 'CARGO INDEBIDO 21 SEP 35552',
        }),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.autoMatchPendientes(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(fila(db, 'dev')).toMatchObject({
      cobro_id: null,
      reverso_de_id: 'c21',
      conciliado: true,
    });
    expect(r.reversos_emparejados).toBe(1);
    expect(r.conciliados).toBe(0);
  });

  it('control: el MISMO monto sin leyenda de devolución SÍ se liga al cobro (la leyenda es lo que decide)', async () => {
    const db = mundo({
      cobro_vuelo: [cobroCliente()],
      movimiento_bancario: [
        mov('c21'),
        mov('spei', {
          tipo: 'ABONO',
          fecha: '2026-09-23',
          descripcion: 'SPEI RECIBIDO CLIENTE UNO',
        }),
      ],
    });
    const { svc } = armar(db);
    await svc.autoMatchPendientes(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(fila(db, 'spei')).toMatchObject({
      cobro_id: 'cobro-cliente',
      reverso_de_id: null,
    });
    // Y el cargo NO se empareja con un pago de cliente.
    expect(fila(db, 'c21')).toMatchObject({
      conciliado: false,
      clasificacion_id: null,
    });
  });

  it('sin la migración: la devolución sigue el camino de siempre (como el 0.0.43)', async () => {
    const db = mundo({
      cobro_vuelo: [cobroCliente()],
      movimiento_bancario: [
        mov('dev', {
          tipo: 'ABONO',
          fecha: '2026-09-23',
          descripcion: 'CARGO INDEBIDO 21 SEP 35552',
        }),
      ].map((m) => {
        const { reverso_de_id: _omit, ...resto } = m;
        void _omit;
        return resto;
      }),
    });
    const { svc } = armar(db, { sinReverso: true });
    await svc.autoMatchPendientes(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(fila(db, 'dev').cobro_id).toBe('cobro-cliente');
  });
});

/**
 * 1 cargo ↔ N gastos (2-oct-2026, migración 20261002000002): un cargo que
 * paga VARIOS gastos tiene `gasto_id` null (espejo) y `gastos_n ≥ 2`. Para
 * el par cargo ↔ devolución cuenta como ligado a gasto: jamás se empareja
 * ni se ofrece, y frena al automático igual que un cargo con UN gasto.
 */
describe('reversos con un cargo que paga VARIOS gastos (lote)', () => {
  const LOTE = 'c-lote';
  const conLote = () => {
    const db = mundo();
    // El cargo del gasto pasa a pagar DOS gastos: espejo null, 2 partes.
    db.movimiento_bancario = db.movimiento_bancario.filter(
      (m) => m.id !== CARGO_CON_GASTO,
    );
    db.movimiento_bancario.push(
      mov(LOTE, { conciliado: true, gasto_id: null }),
    );
    db.movimiento_bancario_gasto = [
      {
        movimiento_id: LOTE,
        gasto_id: 'g-a',
        monto_parte: 412.56,
        moneda: 'MXN',
      },
      {
        movimiento_id: LOTE,
        gasto_id: 'g-b',
        monto_parte: 412.57,
        moneda: 'MXN',
      },
    ];
    return db;
  };

  it('el cargo del lote NO es candidato y su diálogo responde 409', async () => {
    const { svc, db } = armar(conLote());
    expect(fila(db, LOTE).gastos_n).toBe(2);
    const c = await svc.candidatosReverso(ABONO_1);
    expect(c.map((x) => x.id)).not.toContain(LOTE);
    expect(c.map((x) => x.id).sort()).toEqual([...CARGOS_IDS].sort());
    expect((await error(svc.candidatosReverso(LOTE))).code).toBe(
      'MOVIMIENTO_YA_LIGADO',
    );
  });

  it('emparejar a mano con el cargo del lote ⇒ 409 que dice cuántos gastos', async () => {
    const { svc, db } = armar(conLote());
    const r = await error(svc.emparejarReverso(ABONO_1, LOTE, USER));
    expect(r.code).toBe('REVERSO_INVALIDO');
    expect(r.message).toBe(
      'El cargo ya está conciliado con 2 gastos: quítalo antes.',
    );
    expect(fila(db, ABONO_1).reverso_de_id).toBeNull();
    expect(fila(db, LOTE)).toMatchObject({ conciliado: true, gastos_n: 2 });
  });

  it('«Emparejar devoluciones» jamás toca el cargo del lote', async () => {
    const { svc, db } = armar(conLote());
    const r = await svc.autoReversos(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(r.emparejados).toBe(7);
    expect(fila(db, LOTE)).toMatchObject({
      clasificacion_id: null,
      notas: null,
      gastos_n: 2,
    });
    expect(
      ABONOS.map(([id]) => fila(db, id).reverso_de_id).includes(LOTE),
    ).toBe(false);
  });
});
