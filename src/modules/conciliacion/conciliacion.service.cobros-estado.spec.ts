import { ConciliacionService } from './conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';

/**
 * UN COBRO, VARIOS ABONOS — LECTURAS DEL ESTADO (14-oct-2026, API 0.0.78,
 * invariante 77). Caso real de las camionetas de Beh Kay (#315): un cobro de
 * $3,400 que se pagó con DOS SPEI de $1,700. Se congela, con la puente de
 * 20261012000002 y SIN depender de 20261014000003 (la sonda solo gatea lo
 * que propone un segundo abono):
 * - candidatos-cobro: «ocupado» = CUBIERTO por otros abonos (con la sonda);
 *   un PARCIAL entra con sus aditivos y `dif_monto` contra su faltante; el
 *   abono de la PASARELA no recibe parciales; sin la sonda, como el 0.0.77;
 * - «Cobros sin banco»: los PARCIALES siguen ahí con `faltante` y sus
 *   abonos; `parciales` y `por_moneda[].faltante`;
 * - la bandeja: `cobro_conciliacion` (con `faltante_sin_este`) en un abono
 *   de UN cobro y el estado de cada cobro de un lote; lectura caída ⇒ sin
 *   anotar el estado (best-effort, el lote de siempre se queda);
 * - el Excel: «pago parcial: este abono … de … (faltan …)», «2 de 2 abonos»
 *   y el lote con «de … · completa el cobro»; lectura caída ⇒ el reporte
 *   se TUMBA.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = 'cta-mxn';
const CTA_USD = 'cta-usd';
const CTA_PW = 'cta-paywise';

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

/** Columnas que NO existen sin sus migraciones (42703 al nombrarlas). */
const COLUMNAS_AUSENTES = [
  'ingreso_id',
  'ingreso_anticipo_id',
  'gastos_n',
  'reverso_de_id',
  'orden_archivo',
  'folio_releido_at',
];

interface Opciones {
  /** Sin 20261014000003: la sonda (`regla_cobro_cubierto`) responde PGRST202. */
  sinParciales?: boolean;
  /** `tabla` ⇒ error en su próxima lectura (con `.in(...)` de esa columna). */
  falla?: { tabla: string; columna?: string };
}

/**
 * Mini-PostgREST en memoria con los embeds que usan las lecturas: `vuelo`
 * (+ `cliente`), `cobro`, la cuenta del movimiento y el abono de la puente
 * (+ su cuenta); respeta `order`/`range`.
 */
function fakeSupabase(db: Tablas, opts: Opciones = {}) {
  const log: Array<{ tabla: string; sel: string }> = [];
  const conCuenta = (sel: string, r: Row | null | undefined): Row | null => {
    if (!r) return null;
    return sel.includes('cuenta:cuenta_bancaria')
      ? {
          ...r,
          cuenta:
            (db.cuenta_bancaria ?? []).find(
              (c) => c.id === r.cuenta_bancaria_id,
            ) ?? null,
        }
      : { ...r };
  };
  const embeber = (tabla: string, sel: string, r: Row): Row => {
    let out: Row = { ...r };
    if (/\bvuelo:vuelo!vuelo_id\(/.test(sel)) {
      const v = (db.vuelo ?? []).find((x) => x.id === r.vuelo_id) ?? null;
      out.vuelo = v
        ? {
            ...v,
            cliente:
              (db.cliente ?? []).find((c) => c.id === v.cliente_id) ?? null,
          }
        : null;
    }
    if (/\bmovimiento:movimiento_bancario!movimiento_id\(/.test(sel)) {
      out.movimiento = conCuenta(
        sel,
        (db.movimiento_bancario ?? []).find((x) => x.id === r.movimiento_id),
      );
    } else if (tabla === 'movimiento_bancario') {
      out = conCuenta(sel, out) as Row;
    }
    if (
      tabla === 'movimiento_bancario' &&
      /\bcobro:cobro_vuelo!cobro_id\(/.test(sel)
    ) {
      const c = (db.cobro_vuelo ?? []).find((x) => x.id === r.cobro_id);
      out.cobro = c
        ? {
            ...c,
            vuelo: (db.vuelo ?? []).find((v) => v.id === c.vuelo_id) ?? null,
          }
        : null;
    }
    return out;
  };
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' = 'select';
      let patch: Row = {};
      let sel = '';
      let rango: [number, number] | null = null;
      let limite: number | null = null;
      let columnaIn = '';
      const orden: Array<[string, boolean]> = [];
      let prohibido = false;
      const entrada = { tabla, sel: '' };
      log.push(entrada);
      const marcar = (texto: string) => {
        for (const c of COLUMNAS_AUSENTES) {
          if (new RegExp(`\\b${c}\\b`).test(texto)) prohibido = true;
        }
      };
      const ejecutar = (unico: boolean) => {
        if (prohibido) {
          return {
            data: null,
            error: {
              code: '42703',
              message: `column ${tabla}.x does not exist`,
            },
            count: null,
          };
        }
        if (
          opts.falla &&
          opts.falla.tabla === tabla &&
          (!opts.falla.columna || opts.falla.columna === columnaIn)
        ) {
          return {
            data: null,
            error: {
              code: '57014',
              message: 'canceling statement due to statement timeout',
            },
            count: null,
          };
        }
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        if (op === 'update') filas.forEach((r) => Object.assign(r, patch));
        let out = filas.map((r) => embeber(tabla, sel, r));
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
          sel = s ?? '';
          entrada.sel = sel;
          marcar(sel);
          return api;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
          return api;
        },
        eq(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          filtros.push((r) => r[col] !== val);
          return api;
        },
        is(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        not(col: string, o: string, val: unknown) {
          marcar(col);
          if (o === 'is' && val === null)
            filtros.push((r) => (r[col] ?? null) !== null);
          return api;
        },
        in(col: string, vals: unknown[]) {
          marcar(col);
          columnaIn = col;
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        or(cond: string) {
          marcar(cond);
          filtros.push((r) =>
            cond.split(',').some((c) => {
              const m = /^([^.]+)\.(\w+)\.(.*)$/.exec(c);
              if (!m) return false;
              const [, col, o, raw] = m;
              if (o === 'not') return (r[col] ?? null) !== null;
              if (o === 'eq') return String(r[col]) === raw;
              return false;
            }),
          );
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
    rpc(nombre: string) {
      log.push({ tabla: `rpc:${nombre}`, sel: '' });
      if (nombre === 'regla_cobro_cubierto') {
        return Promise.resolve(
          opts.sinParciales
            ? {
                data: null,
                error: {
                  code: 'PGRST202',
                  message:
                    'Could not find the function public.regla_cobro_cubierto(p_cruzado, p_n_partes, p_neto, p_suma) in the schema cache',
                },
              }
            : { data: true, error: null },
        );
      }
      return Promise.resolve({
        data: null,
        error: { code: 'PGRST202', message: `Could not find ${nombre}` },
      });
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-15',
  tipo: 'ABONO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'TRANSF INTERBANCARIA SPEI',
  referencia: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  origen: 'IMPORTADO',
  notas: null,
  created_at: '2026-10-06T15:22:46Z',
  cobros_n: 0,
  ...extra,
});

/** Abono ligado a UN cobro (espejo `cobro_id` + su parte = |abono|). */
const ligado = (id: string, monto: number, cobroId: string, extra: Row = {}) =>
  abono(id, monto, {
    conciliado: true,
    cobro_id: cobroId,
    cobros_n: 1,
    ...extra,
  });

const parte = (movId: string, cobroId: string, monto: number): Row => ({
  movimiento_id: movId,
  cobro_id: cobroId,
  monto_parte: monto,
  created_at: '2026-10-13T16:00:00Z',
  created_by: null,
});

const cobro = (
  id: string,
  vueloId: string,
  monto: number,
  extra: Row = {},
): Row => ({
  id,
  vuelo_id: vueloId,
  monto,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  fecha_cobro: '2026-09-15T17:00:00Z',
  referencia: null,
  comision_banco_monto: null,
  cobro_grupo_id: null,
  ...extra,
});

/**
 * Beh Kay: #315 ($3,400) con un SPEI de $1,700 ligado (m1) y otro de $1,700
 * pendiente (m2); #316 ($1,000) cubierto por m3; #317 ($500) libre; #318
 * ($17,500) ligado a un abono de la cuenta en DÓLARES (m4: cruzado).
 */
function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'EJE SCOTIA',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
      {
        id: CTA_USD,
        alias: 'HSBC USD',
        banco: 'HSBC',
        moneda: 'USD',
        tipo: 'BANCO',
      },
      {
        id: CTA_PW,
        alias: 'Paywise',
        banco: 'Paywise',
        moneda: 'MXN',
        tipo: 'PASARELA',
      },
    ],
    cliente: [{ id: 'k-behkay', nombre: 'Beh Kay', activo: true }],
    vuelo: [315, 316, 317, 318, 332].map((f) => ({
      id: `v${f}`,
      folio: f,
      fecha_vuelo: '2026-09-15T14:00:00Z',
      cliente_id: 'k-behkay',
      aeronave_id: 'a1',
    })),
    movimiento_bancario: [
      ligado('m1', 1700, 'c315', { fecha: '2026-09-15' }),
      abono('m2', 1700, { fecha: '2026-09-16' }),
      ligado('m3', 1000, 'c316'),
      ligado('m4', 1000, 'c318', { cuenta_bancaria_id: CTA_USD }),
    ],
    movimiento_bancario_cobro: [
      parte('m1', 'c315', 1700),
      parte('m3', 'c316', 1000),
      parte('m4', 'c318', 1000),
    ],
    cobro_vuelo: [
      cobro('c315', 'v315', 3400),
      cobro('c316', 'v316', 1000),
      cobro('c317', 'v317', 500),
      cobro('c318', 'v318', 17500),
    ],
    cobro_grupo: [],
    tarjeta_corporativa: [],
    conciliacion_clasificacion: [],
    ...extra,
  };
}

function armar(db: Tablas, opts: Opciones = {}) {
  const f = fakeSupabase(db, opts);
  const filasXlsx: unknown[][][] = [];
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    {
      generateTablaXlsx: jest.fn((p: { filas: unknown[][] }) => {
        filasXlsx.push(p.filas);
        return Promise.resolve(Buffer.from('xlsx'));
      }),
    } as unknown as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, log: f.log, filasXlsx };
}

/** La 2.ª transferencia de $1,700 ya ligada (m2 ⇒ #315): el cobro queda cubierto. */
function conSegundoAbono(db: Tablas): Tablas {
  const m2 = db.movimiento_bancario.find((m) => m.id === 'm2')!;
  Object.assign(m2, { conciliado: true, cobro_id: 'c315', cobros_n: 1 });
  db.movimiento_bancario_cobro.push(parte('m2', 'c315', 1700));
  return db;
}

describe('candidatos-cobro — «ocupado» = CUBIERTO por OTROS abonos (invariante 77)', () => {
  it('con la sonda: el cobro PARCIAL de #315 es candidato del 2.º SPEI con sus aditivos y ★ contra lo que falta', async () => {
    const { svc } = armar(mundo());
    const r = await svc.candidatosCobro('m2', 30);
    expect(r.movimiento).toMatchObject({
      cobros_n: 0,
      cobros_parciales: true,
      tipo_cuenta: 'BANCO',
    });
    // #316 (cubierto por m3) y #318 (ligado a un abono en dólares) quedan fuera.
    expect(r.candidatos.map((c) => c.id).sort()).toEqual(['c315', 'c317']);
    const c315 = r.candidatos.find((c) => c.id === 'c315')!;
    expect(c315).toMatchObject({
      neto: 3400,
      parcial: true,
      monto_vinculado: 1700,
      faltante: 1700,
      abonos_n: 1,
      abonos: [{ movimiento_id: 'm1', fecha: '2026-09-15', monto_parte: 1700 }],
      dif_monto: 0,
    });
    expect(r.exactos).toBe(1);
    // El libre de siempre: sin abonos ⇒ faltante = neto y dif contra el neto.
    expect(r.candidatos.find((c) => c.id === 'c317')).toMatchObject({
      parcial: false,
      monto_vinculado: 0,
      faltante: 500,
      abonos_n: 0,
      abonos: [],
      dif_monto: 1200,
    });
  });

  it('el abono que YA paga el cobro lo ve sin sus propias partes (re-ligar = lo de siempre)', async () => {
    const { svc } = armar(mundo());
    const r = await svc.candidatosCobro('m1', 30);
    expect(r.candidatos.find((c) => c.id === 'c315')).toMatchObject({
      parcial: false,
      faltante: 3400,
      abonos_n: 0,
      dif_monto: 1700,
    });
  });

  it('cubierto con los dos SPEI ⇒ ya no es candidato de un tercer abono', async () => {
    const db = conSegundoAbono(mundo());
    db.movimiento_bancario.push(abono('m5', 100));
    const { svc } = armar(db);
    const r = await svc.candidatosCobro('m5', 30);
    expect(r.candidatos.map((c) => c.id)).toEqual(['c317']);
  });

  it('SIN la sonda (BD sin 20261014000003): «tiene liga» = ocupado, como el 0.0.77', async () => {
    const { svc } = armar(mundo(), { sinParciales: true });
    const r = await svc.candidatosCobro('m2', 30);
    expect(r.candidatos.map((c) => c.id)).toEqual(['c317']);
    expect(r.movimiento.cobros_parciales).toBe(false);
  });

  it('un abono de la PASARELA no recibe cobros parciales', async () => {
    const db = mundo();
    db.movimiento_bancario.push(
      abono('m-pw', 1700, { cuenta_bancaria_id: CTA_PW }),
    );
    const { svc } = armar(db);
    const r = await svc.candidatosCobro('m-pw', 30);
    expect(r.movimiento).toMatchObject({ tipo_cuenta: 'PASARELA' });
    expect(r.candidatos.map((c) => c.id)).toEqual(['c317']);
  });
});

describe('cobros-sin-banco — los PARCIALES siguen en la lista (invariante 77)', () => {
  it('#315 con un SPEI de $1,700 sale como parcial con lo que falta y su abono; el cubierto y el cruzado no', async () => {
    const { svc } = armar(mundo());
    const r = await svc.cobrosSinBanco('2026-09-01', '2026-09-30');
    expect(r.data.map((c) => c.id).sort()).toEqual(['c315', 'c317']);
    expect(r.data.find((c) => c.id === 'c315')).toMatchObject({
      parcial: true,
      neto: 3400,
      monto_vinculado: 1700,
      faltante: 1700,
      abonos_n: 1,
      abonos: [{ movimiento_id: 'm1', fecha: '2026-09-15', monto_parte: 1700 }],
    });
    expect(r.data.find((c) => c.id === 'c317')).toMatchObject({
      parcial: false,
      monto_vinculado: 0,
      faltante: 500,
      abonos_n: 0,
      abonos: [],
    });
    expect(r.total).toBe(2);
    expect(r.parciales).toBe(1);
    // `monto` sigue siendo Σ bruto; `faltante`, Σ de lo que falta.
    expect(r.por_moneda).toEqual([
      { moneda: 'MXN', monto: 3900, faltante: 2200 },
    ]);
  });

  it('con el 2.º SPEI ligado, #315 sale de la lista', async () => {
    const { svc } = armar(conSegundoAbono(mundo()));
    const r = await svc.cobrosSinBanco('2026-09-01', '2026-09-30');
    expect(r.data.map((c) => c.id)).toEqual(['c317']);
    expect(r.parciales).toBe(0);
  });

  it('una lectura de ligas caída ⇒ se LANZA (jamás «sin banco» de oídas)', async () => {
    const { svc } = armar(mundo(), {
      falla: { tabla: 'movimiento_bancario_cobro', columna: 'cobro_id' },
    });
    await expect(
      svc.cobrosSinBanco('2026-09-01', '2026-09-30'),
    ).rejects.toThrow(/timeout/);
  });
});

describe('bandeja (GET movimientos) — estado del cobro en cada abono', () => {
  it('abono con UN cobro: cobro_conciliacion PARCIAL con faltante_sin_este', async () => {
    const { svc } = armar(mundo());
    const r = await svc.list({ limit: 50, offset: 0 });
    const m1 = r.data.find((x) => x.id === 'm1') as Row;
    expect(m1.cobro_conciliacion).toEqual({
      cobro_id: 'c315',
      folio: 315,
      estado: 'PARCIAL',
      neto: 3400,
      monto_vinculado: 1700,
      faltante: 1700,
      sobrante: 0,
      abonos_n: 1,
      faltante_sin_este: 3400,
      abonos: [{ movimiento_id: 'm1', fecha: '2026-09-15', monto_parte: 1700 }],
    });
    // #318: abono en otra moneda ⇒ cubierto por definición.
    const m4 = r.data.find((x) => x.id === 'm4') as Row;
    expect(m4.cobro_conciliacion).toMatchObject({
      estado: 'CONCILIADO',
      faltante: 0,
    });
    // Un abono pendiente no lleva el aditivo.
    expect(r.data.find((x) => x.id === 'm2')).not.toHaveProperty(
      'cobro_conciliacion',
    );
  });

  it('con los dos SPEI: cada abono dice CONCILIADO, 2 abonos y lo que faltaría sin él', async () => {
    const { svc } = armar(conSegundoAbono(mundo()));
    const r = await svc.list({ limit: 50, offset: 0 });
    for (const id of ['m1', 'm2']) {
      expect(
        (r.data.find((x) => x.id === id) as Row).cobro_conciliacion,
      ).toMatchObject({
        estado: 'CONCILIADO',
        abonos_n: 2,
        faltante: 0,
        faltante_sin_este: 1700,
        abonos: [
          { movimiento_id: 'm1', fecha: '2026-09-15', monto_parte: 1700 },
          { movimiento_id: 'm2', fecha: '2026-09-16', monto_parte: 1700 },
        ],
      });
    }
  });

  it('un LOTE (SPEI de $69,183.00 = #315 $68,205.55 + #332 $977.45): cada cobro con su estado', async () => {
    const db = mundo({
      movimiento_bancario: [
        abono('m-lote', 69183, { conciliado: true, cobros_n: 2 }),
      ],
      movimiento_bancario_cobro: [
        parte('m-lote', 'c315b', 68205.55),
        parte('m-lote', 'c332', 977.45),
      ],
      cobro_vuelo: [
        cobro('c315b', 'v315', 68205.55),
        cobro('c332', 'v332', 977.45),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.list({ limit: 50, offset: 0 });
    const m = r.data.find((x) => x.id === 'm-lote') as Row;
    expect(m.cobros_suma).toBe(69183);
    expect(m.cobros_diferencia).toBe(0);
    expect(m.cobros).toEqual([
      expect.objectContaining({
        cobro_id: 'c315b',
        folio: 315,
        monto_parte: 68205.55,
        cobro_estado: 'CONCILIADO',
        cobro_neto: 68205.55,
        cobro_faltante: 0,
        cobro_abonos_n: 1,
      }),
      expect.objectContaining({
        cobro_id: 'c332',
        folio: 332,
        cobro_estado: 'CONCILIADO',
        cobro_abonos_n: 1,
      }),
    ]);
    expect(m).not.toHaveProperty('cobro_conciliacion');
  });

  it('la lectura del estado cae ⇒ sin `cobro_conciliacion` (warn) y la página sale igual', async () => {
    const { svc } = armar(mundo(), {
      falla: { tabla: 'movimiento_bancario_cobro', columna: 'cobro_id' },
    });
    const r = await svc.list({ limit: 50, offset: 0 });
    const m1 = r.data.find((x) => x.id === 'm1') as Row;
    expect(m1).not.toHaveProperty('cobro_conciliacion');
    expect(m1.cobros_n).toBe(1);
  });
});

describe('Excel de conciliación — «Conciliado con» con el estado del cobro', () => {
  const conciliadoCon = (filas: unknown[][], fecha: string, monto: number) =>
    filas.find((f) => f[0] === fecha && f[5] === monto)?.[7];

  it('«pago parcial: este abono $1,700.00 de $3,400.00 (faltan $1,700.00)»; con los dos SPEI, «1 de 2» y «2 de 2 abonos»', async () => {
    const { svc, filasXlsx } = armar(mundo());
    await svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    expect(conciliadoCon(filasXlsx[0], '2026-09-15', 1700)).toBe(
      'Cobro · vuelo #315 · Transferencia · pago parcial: este abono $1,700.00 de $3,400.00 (faltan $1,700.00)',
    );
    // El cobro cubierto con un solo abono: el texto de siempre.
    expect(conciliadoCon(filasXlsx[0], '2026-09-15', 1000)).toBe(
      'Cobro · vuelo #316 · Transferencia',
    );
    const otro = armar(conSegundoAbono(mundo()));
    await otro.svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    expect(conciliadoCon(otro.filasXlsx[0], '2026-09-15', 1700)).toBe(
      'Cobro · vuelo #315 · Transferencia · 1 de 2 abonos ($3,400.00 cubierto)',
    );
    expect(conciliadoCon(otro.filasXlsx[0], '2026-09-16', 1700)).toBe(
      'Cobro · vuelo #315 · Transferencia · 2 de 2 abonos ($3,400.00 cubierto)',
    );
  });

  it('lote por FALTANTE (Villanueva $69,000 = 50,999 + 18,001 que le faltaban a #278)', async () => {
    const db = mundo({
      vuelo: [
        { id: 'v277', folio: 277, cliente_id: 'k-behkay', aeronave_id: 'a1' },
        { id: 'v278', folio: 278, cliente_id: 'k-behkay', aeronave_id: 'a1' },
      ],
      movimiento_bancario: [
        abono('m-prev', 10000, {
          conciliado: true,
          cobro_id: 'c278',
          cobros_n: 1,
          fecha: '2026-09-10',
        }),
        abono('m-lote', 69000, { conciliado: true, cobros_n: 2 }),
      ],
      movimiento_bancario_cobro: [
        parte('m-prev', 'c278', 10000),
        parte('m-lote', 'c277', 50999),
        parte('m-lote', 'c278', 18001),
      ],
      cobro_vuelo: [cobro('c277', 'v277', 50999), cobro('c278', 'v278', 28001)],
    });
    const { svc, filasXlsx } = armar(db);
    await svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    expect(conciliadoCon(filasXlsx[0], '2026-09-15', 69000)).toBe(
      '2 cobros: vuelo #277 · Beh Kay ($50,999.00) · vuelo #278 · Beh Kay ($18,001.00 de $28,001.00 · completa el cobro)',
    );
    expect(conciliadoCon(filasXlsx[0], '2026-09-10', 10000)).toBe(
      'Cobro · vuelo #278 · Transferencia · 1 de 2 abonos ($28,001.00 cubierto)',
    );
  });

  it('la lectura de la cobertura cae ⇒ el reporte se TUMBA (jamás un «Conciliado con» incompleto)', async () => {
    const { svc } = armar(mundo(), {
      falla: { tabla: 'movimiento_bancario_cobro', columna: 'cobro_id' },
    });
    await expect(
      svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos'),
    ).rejects.toThrow(/timeout/);
  });
});
