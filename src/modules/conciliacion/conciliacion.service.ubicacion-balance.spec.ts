import { ConciliacionService } from './conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import {
  rpcPartes,
  sembrarPartes,
  TABLA_PARTES,
  VISTA_CONCILIACION,
  type OpcionesRpc,
  type ErrorBd,
} from './conciliacion-partes.fixture-spec';

/**
 * VÍNCULO GASTO → BALANCE en Conciliación (13-oct-2026, API 0.0.75,
 * invariante 72): `GET movimientos` pone en `gasto` y en cada `gastos[]` el
 * ADITIVO `balance` (en qué libro y en qué mes vive el gasto), con lecturas
 * PROPIAS y best-effort. Casos reales: OPERACIONES #430 de N4142R (10-oct),
 * la «gestoria cramex sep» INDIRECTO $16,240 repartida 50/50 y el hueco
 * #255 (sellado a N4142R en un vuelo de XA-VGV sin tramo suyo). El
 * PostgREST falso es copia del de conciliacion.service.lote.spec.ts (resuelve
 * `escala:escala_id(…)` y `vuelo:vuelo_id(…)`).
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = 'cta-gastos';

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
  if (typeof b === 'number') return Number(a) - b;
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/** Parte una lista PostgREST por comas de nivel 0. */
function partirNivel0(s: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of s) {
    if (ch === '(') nivel += 1;
    if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) {
      out.push(actual.trim());
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (actual.trim()) out.push(actual.trim());
  return out;
}

/** Comodín `*x*` / `%x%` de ilike ⇒ «contiene» (sin distinguir mayúsculas). */
const contiene = (valor: unknown, patron: string) => {
  const p = patron.replace(/^[*%]|[*%]$/g, '').toLowerCase();
  return txt(valor).toLowerCase().includes(p);
};

interface OpcionesFake {
  /** Migración 20261002000002 SIN aplicar. */
  sinPartes?: boolean;
  rpc?: OpcionesRpc;
  /** Tablas cuya lectura falla (lectura best-effort de la lista). */
  fallaLectura?: string[];
  /** Tope de filas por respuesta, como `max-rows` de PostgREST (sin aviso). */
  maxFilas?: number;
  /** UPDATE que la BD rechaza (trigger / constraint diferido). */
  falloUpdate?: { tabla: string; error: Row | ErrorBd };
  /** Migración 20261005000002 SIN aplicar (`factura_recibida.serie`). */
  sinSerieFolio?: boolean;
  /**
   * Migración 20261012000001 SIN aplicar (`movimiento_bancario.orden_archivo`,
   * conciliación al revés 13-oct-2026): la sonda y cualquier select que la
   * nombre responden 42703.
   */
  sinOrdenArchivo?: boolean;
  /** Lectura puntual que falla (tabla + texto acumulado de la consulta). */
  fallaConsulta?: (tabla: string, texto: string) => boolean;
  /**
   * Corre ANTES de aplicar cada UPDATE (con el patch): simula que alguien
   * escribió la fila entre la lectura y el update (CAS de las notas).
   */
  antesDeUpdate?: (tabla: string, patch: Row, db: Tablas) => void;
}

/** Mini-PostgREST en memoria: filtros, `or`, embeds, orden, RPC y bitácora. */
function fakeSupabase(db: Tablas, opts: OpcionesFake = {}) {
  const log: Array<{ tabla: string; texto: string }> = [];
  const embeber = (fila: Row, sel: string): Row => {
    const out: Row = { ...fila };
    for (const campo of partirNivel0(sel)) {
      // Ruta JSON `alias:columna->>llave` (5-oct-2026: `ia_folio`).
      const j = /^(\w+):(\w+)->>(\w+)$/.exec(campo);
      if (j) {
        const [, alias, col, llave] = j;
        const doc = fila[col] as Row | null | undefined;
        const v = doc && typeof doc === 'object' ? doc[llave] : null;
        out[alias] = v == null ? null : txt(v);
        continue;
      }
      const m = /^(\w+):([\w]+)(?:!(\w+))?\((.*)\)$/s.exec(campo);
      if (!m) continue;
      const [, alias, origen, fk, interior] = m;
      let tabla = origen;
      let col = fk ?? `${origen}_id`;
      if (origen.endsWith('_id') && !fk) {
        tabla = origen.slice(0, -3);
        col = origen;
      }
      const id = fila[col];
      const rel = (db[tabla] ?? []).find((r) => r.id === id) ?? null;
      out[alias] = rel ? embeber(rel, interior) : null;
    }
    return out;
  };
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row = {};
      let sel = '';
      let head = false;
      let limite: number | null = null;
      let rango: [number, number] | null = null;
      const orden: Array<[string, boolean]> = [];
      const entrada = { tabla, texto: '' };
      log.push(entrada);
      const marcar = (t: string) => {
        entrada.texto += ` ${t}`;
      };
      const ejecutar = (unico: boolean) => {
        if (opts.fallaLectura?.includes(tabla)) {
          return { data: null, error: { message: 'caída' }, count: null };
        }
        if (opts.fallaConsulta?.(tabla, entrada.texto)) {
          return { data: null, error: { message: 'caída' }, count: null };
        }
        if (
          opts.sinPartes &&
          (tabla === TABLA_PARTES || tabla === VISTA_CONCILIACION)
        ) {
          return {
            data: null,
            error: {
              code: '42P01',
              message: `relation ${tabla} does not exist`,
            },
            count: null,
          };
        }
        if (
          opts.sinSerieFolio &&
          ((tabla === 'factura_recibida' && /\bserie\b/.test(entrada.texto)) ||
            /factura_recibida_id\([^)]*\bserie\b/.test(entrada.texto))
        ) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column factura_recibida.serie does not exist',
            },
            count: null,
          };
        }
        if (opts.sinOrdenArchivo && /orden_archivo/.test(entrada.texto)) {
          return {
            data: null,
            error: {
              code: '42703',
              message:
                'column movimiento_bancario.orden_archivo does not exist',
            },
            count: null,
          };
        }
        if (opts.sinPartes && /gastos_n/.test(entrada.texto)) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column movimiento_bancario.gastos_n does not exist',
            },
            count: null,
          };
        }
        if (op === 'update' && opts.falloUpdate?.tabla === tabla) {
          return { data: null, error: opts.falloUpdate.error, count: null };
        }
        if (op === 'update') opts.antesDeUpdate?.(tabla, patch, db);
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        if (op === 'update') filas.forEach((r) => Object.assign(r, patch));
        let out = filas.map((r) => embeber(r, sel));
        for (const [col, asc] of [...orden].reverse()) {
          out.sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        const total = out.length;
        if (rango) out = out.slice(rango[0], rango[1] + 1);
        if (limite != null) out = out.slice(0, limite);
        if (opts.maxFilas != null) out = out.slice(0, opts.maxFilas);
        if (head) return { data: null, error: null, count: total };
        return {
          data: unico ? (out[0] ?? null) : out,
          error: null,
          count: total,
        };
      };
      const cumple = (r: Row, cond: string): boolean => {
        const m = /^([^.]+)\.([a-z]+)\.(.*)$/s.exec(cond);
        if (!m) return false;
        const [, col, o, raw] = m;
        if (o === 'ilike') return contiene(r[col], raw);
        if (o === 'eq') return txt(r[col]) === raw;
        if (o === 'in') {
          return raw
            .replace(/^\(|\)$/g, '')
            .split(',')
            .includes(txt(r[col]));
        }
        return false;
      };
      const api: Record<string, unknown> = {
        select(s?: string, o?: { count?: string; head?: boolean }) {
          sel = s ?? '';
          head = o?.head === true;
          marcar(`select(${sel})`);
          return api;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
          marcar(`update(${Object.keys(p).join(',')})`);
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
        in(col: string, vals: unknown[]) {
          marcar(`in:${col}`);
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        ilike(col: string, val: string) {
          marcar(`ilike:${col}`);
          filtros.push((r) => contiene(r[col], val));
          return api;
        },
        or(cond: string) {
          marcar(`or:${cond}`);
          const partes = partirNivel0(cond);
          filtros.push((r) => partes.some((c) => cumple(r, c)));
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
        not: () => api,
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
        abortSignal: () => api,
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        single: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
    rpc(nombre: string, args: Row) {
      log.push({ tabla: `rpc:${nombre}`, texto: JSON.stringify(args) });
      if (opts.sinPartes) {
        return Promise.resolve({
          data: null,
          error: {
            code: 'PGRST202',
            message: `Could not find the function public.${nombre}`,
          },
        });
      }
      return Promise.resolve(rpcPartes(db, nombre, args, opts.rpc));
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

// ------------------------------- mundo --------------------------------

const N41 = 'av-n41';
const VGV = 'av-vgv';
const PEV = 'av-pev';

const cargo = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-10-10',
  tipo: 'CARGO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'SPEI ENVIADO',
  referencia: null,
  notas: null,
  conciliado: true,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  reverso_de_id: null,
  origen: 'IMPORTADO',
  created_at: '2026-10-11T18:00:00Z',
  ...extra,
});

const gastoFila = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  monto,
  moneda: 'MXN',
  fecha_gasto: '2026-09-30',
  medio_pago: 'TRANSFERENCIA',
  categoria: 'OPERACIONES',
  conciliado: true,
  tc_gasto: null,
  tarjeta_terminacion: null,
  lugar: null,
  notas: null,
  folio_ticket: null,
  vuelo_id: 'v-430',
  escala_id: null,
  aeronave_id: N41,
  inventario_movimiento_id: null,
  proveedor_id: null,
  usuario_captura_id: 'u-jimmy',
  ...extra,
});

function mundo(): Tablas {
  const db: Tablas = {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'GASTOS GNRAL',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
    ],
    aeronave: [
      { id: VGV, matricula: 'XA-VGV' },
      { id: N41, matricula: 'N4142R' },
      { id: PEV, matricula: 'XB-PEV' },
    ],
    vuelo: [
      {
        id: 'v-430',
        folio: 430,
        aeronave_id: N41,
        fecha_vuelo: '2026-10-10T21:30:00+00:00',
        es_externo: false,
      },
      {
        id: 'v-255',
        folio: 255,
        aeronave_id: VGV,
        fecha_vuelo: '2026-09-12T15:00:00+00:00',
        es_externo: false,
      },
    ],
    escala: [
      { id: 'e-255', vuelo_id: 'v-255', aeronave_id: VGV, cancelada_at: null },
      {
        id: 'e-255b',
        vuelo_id: 'v-255',
        aeronave_id: N41,
        cancelada_at: '2026-09-11T10:00:00Z',
      },
    ],
    usuario: [{ id: 'u-jimmy', nombre: 'Jimmy Chi' }],
    proveedor: [],
    tarjeta_corporativa: [],
    conciliacion_clasificacion: [],
    gasto_reparto: [
      { gasto_id: 'g-cramex', aeronave_id: PEV, monto: 8120 },
      { gasto_id: 'g-cramex', aeronave_id: VGV, monto: 8120 },
    ],
    gasto: [
      gastoFila('g-430', 1899.09),
      gastoFila('g-l1', 100, { fecha_gasto: '2026-10-09' }),
      gastoFila('g-l2', 100, { fecha_gasto: '2026-10-09' }),
      gastoFila('g-l3', 100, { fecha_gasto: '2026-10-09' }),
      gastoFila('g-otro', 500, { categoria: 'OTRO' }),
      gastoFila('g-cramex', 16240, {
        categoria: 'INDIRECTO',
        vuelo_id: null,
        aeronave_id: null,
        fecha_gasto: '2026-10-07',
        notas: 'gestoria cramex sep',
      }),
      gastoFila('g-255', 283.15, {
        vuelo_id: 'v-255',
        aeronave_id: N41,
        fecha_gasto: '2026-09-12',
      }),
    ],
    movimiento_bancario: [
      cargo('m-430', 1899.09, { gasto_id: 'g-430' }),
      cargo('m-lote', 300),
      cargo('m-otro', 500, { gasto_id: 'g-otro' }),
      cargo('m-cramex', 16240, { gasto_id: 'g-cramex' }),
      cargo('m-255', 283.15, { gasto_id: 'g-255' }),
    ],
  };
  // El lote: UN cargo de $300 paga los 3 gastos de $100 (gasto_id espejo null).
  db[TABLA_PARTES] = ['g-l1', 'g-l2', 'g-l3'].map((gid) => ({
    movimiento_id: 'm-lote',
    gasto_id: gid,
    monto_parte: 100,
    moneda: 'MXN',
    created_at: '2026-10-11T18:00:00Z',
    created_by: 'u-jimmy',
  }));
  return db;
}

function armar(db: Tablas, opts: OpcionesFake = {}) {
  sembrarPartes(db);
  const f = fakeSupabase(db, opts);
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    { generateTablaXlsx: jest.fn() } as unknown as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, log: f.log };
}

type Fila = Record<string, unknown>;
const listar = async (w: ReturnType<typeof armar>) =>
  (await w.svc.list({ limit: 100, offset: 0 })).data as Fila[];
const movDe = (filas: Fila[], id: string) => filas.find((m) => m.id === id)!;
const gastoDe = (m: Fila) => m.gasto as Fila;

describe('GET movimientos — `balance` de cada gasto ligado (invariante 72)', () => {
  it('(a) 1↔1: OPERACIONES de #430 vive en el libro de N4142R y en el general de OCTUBRE (mes del vuelo)', async () => {
    const filas = await listar(armar(mundo()));
    expect(gastoDe(movDe(filas, 'm-430')).balance).toEqual({
      periodo: { desde: '2026-10-01', hasta: '2026-10-31' },
      eje: 'vuelo',
      aviones: [{ id: N41, matricula: 'N4142R' }],
      general: true,
      hoja_avion: 'reporte_horas',
      hoja_general: 'reporte_horas',
    });
  });

  it('(b) lote de 3: cada gastos[] lleva su balance', async () => {
    const filas = await listar(armar(mundo()));
    const lote = movDe(filas, 'm-lote');
    const gastos = lote.gastos as Fila[];
    expect(gastos.map((g) => g.id)).toEqual(['g-l1', 'g-l2', 'g-l3']);
    for (const g of gastos) {
      expect(g.balance).toMatchObject({
        eje: 'vuelo',
        aviones: [{ id: N41, matricula: 'N4142R' }],
        hoja_avion: 'reporte_horas',
      });
    }
  });

  it('(c) OTRO con vuelo ⇒ solo el general («otros gastos»), eje gasto', async () => {
    const filas = await listar(armar(mundo()));
    expect(gastoDe(movDe(filas, 'm-otro')).balance).toEqual({
      periodo: { desde: '2026-09-01', hasta: '2026-09-30' },
      eje: 'gasto',
      aviones: [],
      general: true,
      hoja_avion: null,
      hoja_general: 'otros_gastos',
    });
  });

  it('(d) INDIRECTO repartido 50/50 ⇒ los dos aviones ordenados por matrícula y sin general', async () => {
    const filas = await listar(armar(mundo()));
    expect(gastoDe(movDe(filas, 'm-cramex')).balance).toEqual({
      periodo: { desde: '2026-10-01', hasta: '2026-10-31' },
      eje: 'gasto',
      aviones: [
        { id: VGV, matricula: 'XA-VGV' },
        { id: PEV, matricula: 'XB-PEV' },
      ],
      general: false,
      hoja_avion: 'gastos_indirectos',
      hoja_general: null,
    });
  });

  it('(e) caso #255: sellado a N4142R sin tramo VIVO en un vuelo de XA-VGV ⇒ balance null', async () => {
    const w = armar(mundo());
    const filas = await listar(w);
    const m = movDe(filas, 'm-255');
    expect(gastoDe(m)).toHaveProperty('balance', null);
    // Se leyeron SOLO las escalas vivas de ese vuelo.
    const esc = w.log.filter((q) => q.tabla === 'escala');
    expect(esc).toHaveLength(1);
    expect(esc[0].texto).toContain('is:cancelada_at');
    // Con un tramo vivo de N4142R, vuelve a tener enlace.
    const db = mundo();
    db.escala.push({
      id: 'e-255c',
      vuelo_id: 'v-255',
      aeronave_id: N41,
      cancelada_at: null,
    });
    const otra = await listar(armar(db));
    expect(gastoDe(movDe(otra, 'm-255')).balance).toMatchObject({
      aviones: [{ id: N41, matricula: 'N4142R' }],
    });
  });

  it('(f) falla gasto_reparto ⇒ NINGÚN gasto trae `balance` y el resto de la respuesta es igual', async () => {
    const sinBalance = (filas: Fila[]) =>
      JSON.parse(
        JSON.stringify(filas, (k, v: unknown) =>
          k === 'balance' ? undefined : v,
        ),
      ) as Fila[];
    const bien = await listar(armar(mundo()));
    const mal = await listar(
      armar(mundo(), { fallaLectura: ['gasto_reparto'] }),
    );
    expect(JSON.stringify(mal)).not.toContain('"balance"');
    expect(mal).toEqual(sinBalance(bien));
  });

  it('(g) falla la lectura de aeronave ⇒ balance con matrícula null (cosmética)', async () => {
    const filas = await listar(armar(mundo(), { fallaLectura: ['aeronave'] }));
    expect(gastoDe(movDe(filas, 'm-430')).balance).toMatchObject({
      aviones: [{ id: N41, matricula: null }],
      hoja_avion: 'reporte_horas',
    });
  });

  it('(h) lectura PROPIA: una consulta a gasto con los embeds por columna; el select de la bandeja no cambia', async () => {
    const w = armar(mundo());
    await listar(w);
    expect(
      w.log.some(
        (q) =>
          q.tabla === 'gasto' &&
          q.texto.includes(
            'escala:escala_id(aeronave_id), vuelo:vuelo_id(fecha_vuelo, aeronave_id, es_externo)',
          ),
      ),
    ).toBe(true);
    for (const q of w.log.filter((x) => x.tabla === 'movimiento_bancario')) {
      expect(q.texto).not.toContain('escala:');
    }
  });
});
