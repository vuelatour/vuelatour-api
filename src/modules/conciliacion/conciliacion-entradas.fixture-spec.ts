/**
 * PostgREST FALSO + FILAS REALES de prod para la CONCILIACIÓN AL REVÉS DE
 * UNA ENTRADA (14-oct-2026, API 0.0.78, invariante 78). Fuera del build
 * (`*spec.ts`) y de jest (no termina en `.spec.ts`): patrón
 * `*.fixture-spec.ts` del repo.
 *
 * Las filas se leyeron de prod (bjesduasnzbzywofukbf) con SELECT el
 * 15-oct-2026: cuentas, usuarios, clientes, vuelos, cobros, abonos, partes de
 * la puente, estados de cuenta, ingresos y su bitácora. Lo SINTÉTICO va
 * rotulado: los «bordes» de lo importado por cuenta (cargos con las fechas
 * reales de prod de su primer y último movimiento) y el VENENO
 * (`numero_cuenta`, `clabe`, `storage_path`, `foto_voucher_url`,
 * `archivo_path`, notas crudas): valores de mentira que JAMÁS deben salir en
 * una respuesta.
 *
 * El fake respeta lo que la hoja necesita probar: embeds GENÉRICOS y
 * anidados (`alias:tabla!fk(...)`, `alias:col_id(...)`), filtros (eq, neq,
 * is, in, gte/lte/gt/lt con fechas y timestamps comparados como instantes,
 * not, or simple), `order` + `range` + `limit`, el max-rows de 1,000 (corta
 * SIN avisar), `select(…, {count, head})`, `maybeSingle` con PGRST116 si hay
 * 2+ filas, columnas y tablas AUSENTES (sondas ⇒ 42703 / 42P01), lecturas que
 * fallan a pedido, la sonda RPC de 20261014000003 y un LOG de cada consulta.
 * TODA escritura (insert/update/upsert/delete) y toda RPC que no sea la sonda
 * se registra y FALLA: la hoja no escribe nada.
 */
import type { SupabaseService } from '../supabase/supabase.service';

export type Row = Record<string, unknown>;
export type Tablas = Record<string, Row[]>;

export interface ConsultaFake {
  tabla: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';
  /** select + cada filtro, en el orden en que se encadenan (para buscar palabras). */
  texto: string;
  sel: string;
  filtros: Array<[string, string, unknown]>;
  orden: Array<[string, boolean]>;
  rango: [number, number] | null;
  limite: number | null;
  head: boolean;
  count: string | null;
}

export interface OpcionesFakeEntradas {
  /** Palabras (columnas) que NO existen: toda consulta que las nombre ⇒ 42703. */
  ausentes?: string[];
  /** Tablas que NO existen ⇒ 42P01. */
  tablasAusentes?: string[];
  /** 20261014000003 sin aplicar: la sonda `regla_cobro_cubierto` ⇒ PGRST202. */
  sinParciales?: boolean;
  /** Lectura que falla a pedido (tabla + texto acumulado de la consulta). */
  falla?: (tabla: string, texto: string) => boolean;
  /** Filas por respuesta (max-rows de PostgREST). */
  maxRows?: number;
}

/** Columnas/tablas de cada migración, para apagarlas en un spec. */
export const SIN_INGRESOS: Pick<
  OpcionesFakeEntradas,
  'ausentes' | 'tablasAusentes'
> = {
  ausentes: ['ingreso_id', 'ingreso_anticipo_id'],
  tablasAusentes: ['ingreso', 'ingreso_bitacora'],
};
export const SIN_PUENTE: Pick<
  OpcionesFakeEntradas,
  'ausentes' | 'tablasAusentes'
> = {
  ausentes: ['cobros_n'],
  tablasAusentes: ['movimiento_bancario_cobro'],
};

const txt = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v == null
        ? ''
        : JSON.stringify(v);

const esInstante = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);

/** Compara como lo haría Postgres: números, instantes (con zona) o texto. */
function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) - Number(b);
  }
  if (esInstante(a) && esInstante(b)) {
    return Date.parse(a) - Date.parse(b);
  }
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Parte una lista PostgREST por las comas de nivel 0. */
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

/**
 * PROYECCIÓN como PostgREST: solo las columnas pedidas (`*` = todas) y los
 * embeds genéricos y anidados (`alias:tabla!fk(...)`, `alias:col_id(...)`,
 * forma objeto como con una FK única). Una columna que no está en la fila
 * sale null (la fila de prueba no trae todas las de prod).
 */
function proyectar(db: Tablas, fila: Row, sel: string): Row {
  const campos = partirNivel0(sel);
  const out: Row =
    campos.length === 0 || campos.includes('*') ? { ...fila } : {};
  for (const campo of campos) {
    if (campo === '*') continue;
    const m = /^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/s.exec(campo);
    if (m) {
      const [, aliasCrudo, origen, fkCrudo, interior] = m;
      const fk = fkCrudo === 'inner' ? undefined : fkCrudo;
      const alias = aliasCrudo ?? origen;
      let tabla = origen;
      let col = fk ?? `${origen}_id`;
      if (origen.endsWith('_id') && !fk) {
        tabla = origen.slice(0, -3);
        col = origen;
      }
      const id = fila[col];
      const rel = (db[tabla] ?? []).find((r) => r.id === id) ?? null;
      out[alias] = rel ? proyectar(db, rel, interior) : null;
      continue;
    }
    if (/^\w+$/.test(campo)) out[campo] = fila[campo] ?? null;
  }
  return out;
}

const nombra = (texto: string, palabra: string): boolean =>
  new RegExp(`(^|[^a-z_])${palabra}([^a-z_]|$)`).test(texto);

export function fakeEntradas(db: Tablas, opts: OpcionesFakeEntradas = {}) {
  const log: ConsultaFake[] = [];
  const maxRows = opts.maxRows ?? 1000;
  const service = {
    from(tabla: string) {
      const q: ConsultaFake = {
        tabla,
        op: 'select',
        texto: '',
        sel: '',
        filtros: [],
        orden: [],
        rango: null,
        limite: null,
        head: false,
        count: null,
      };
      log.push(q);
      const preds: Array<(r: Row) => boolean> = [];
      const marcar = (t: string) => {
        q.texto += ` ${t}`;
      };
      const filtro = (
        nombre: string,
        col: string,
        val: unknown,
        f: (r: Row) => boolean,
      ) => {
        q.filtros.push([nombre, col, val]);
        marcar(`${nombre}:${col}`);
        preds.push(f);
        return api;
      };
      const ejecutar = (uno: boolean) => {
        if (q.op !== 'select') {
          return {
            data: null,
            error: { code: 'FAKE', message: 'escritura prohibida en la hoja' },
            count: null,
          };
        }
        if (opts.tablasAusentes?.includes(tabla)) {
          return {
            data: null,
            error: {
              code: '42P01',
              message: `relation "public.${tabla}" does not exist`,
            },
            count: null,
          };
        }
        const ausente = (opts.ausentes ?? []).find((c) => nombra(q.texto, c));
        if (ausente) {
          return {
            data: null,
            error: {
              code: '42703',
              message: `column ${tabla}.${ausente} does not exist`,
            },
            count: null,
          };
        }
        if (opts.falla?.(tabla, q.texto)) {
          return { data: null, error: { message: 'caída' }, count: null };
        }
        // Como Postgres: filtra y ORDENA por las columnas de la tabla (pedidas
        // o no), corta y al final proyecta.
        let filas = (db[tabla] ?? []).filter((r) => preds.every((f) => f(r)));
        for (const [col, asc] of [...q.orden].reverse()) {
          filas = [...filas].sort(
            (a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]),
          );
        }
        const total = filas.length;
        if (q.rango) filas = filas.slice(q.rango[0], q.rango[1] + 1);
        if (q.limite != null) filas = filas.slice(0, q.limite);
        filas = filas.slice(0, maxRows).map((r) => proyectar(db, r, q.sel));
        if (q.head) {
          return { data: null, error: null, count: q.count ? total : null };
        }
        if (uno) {
          if (filas.length > 1) {
            return {
              data: null,
              error: {
                code: 'PGRST116',
                message:
                  'JSON object requested, multiple (or no) rows returned',
              },
              count: null,
            };
          }
          return { data: filas[0] ?? null, error: null, count: null };
        }
        return { data: filas, error: null, count: q.count ? total : null };
      };
      const api: Record<string, unknown> = {
        select(s?: string, o?: { count?: string; head?: boolean }) {
          if (q.op === 'select') {
            q.sel = s ?? '*';
            q.head = o?.head === true;
            q.count = o?.count ?? null;
          }
          marcar(`select(${s ?? '*'})`);
          return api;
        },
        insert(r: unknown) {
          q.op = 'insert';
          marcar(`insert(${txt(r)})`);
          return api;
        },
        upsert(r: unknown) {
          q.op = 'upsert';
          marcar(`upsert(${txt(r)})`);
          return api;
        },
        update(r: unknown) {
          q.op = 'update';
          marcar(`update(${txt(r)})`);
          return api;
        },
        delete() {
          q.op = 'delete';
          marcar('delete()');
          return api;
        },
        eq: (col: string, val: unknown) =>
          filtro(
            'eq',
            col,
            val,
            (r) => cmp(r[col], val) === 0 && r[col] != null,
          ),
        neq: (col: string, val: unknown) =>
          filtro('neq', col, val, (r) => r[col] !== val),
        is: (col: string, val: unknown) =>
          filtro('is', col, val, (r) => (r[col] ?? null) === val),
        not: (col: string, o: string, val: unknown) =>
          filtro(`not.${o}`, col, val, (r) =>
            o === 'is' ? (r[col] ?? null) !== val : true,
          ),
        in: (col: string, vals: unknown[]) =>
          filtro('in', col, vals, (r) => vals.includes(r[col])),
        gte: (col: string, val: unknown) =>
          filtro(
            'gte',
            col,
            val,
            (r) => r[col] != null && cmp(r[col], val) >= 0,
          ),
        lte: (col: string, val: unknown) =>
          filtro(
            'lte',
            col,
            val,
            (r) => r[col] != null && cmp(r[col], val) <= 0,
          ),
        gt: (col: string, val: unknown) =>
          filtro('gt', col, val, (r) => r[col] != null && cmp(r[col], val) > 0),
        lt: (col: string, val: unknown) =>
          filtro('lt', col, val, (r) => r[col] != null && cmp(r[col], val) < 0),
        ilike: (col: string, val: string) => {
          const p = val.replace(/^[*%]|[*%]$/g, '').toLowerCase();
          return filtro('ilike', col, val, (r) =>
            txt(r[col]).toLowerCase().includes(p),
          );
        },
        or: (expr: string) => {
          marcar(`or:${expr}`);
          q.filtros.push(['or', '', expr]);
          const conds = partirNivel0(expr).map((c) => {
            const m = /^([a-z_]+)\.(not\.)?(is|eq|in)\.(.*)$/.exec(c.trim());
            if (!m) return () => false;
            const [, col, neg, op, crudo] = m;
            const base = (r: Row): boolean => {
              if (op === 'is') {
                const v = crudo === 'null' ? null : crudo === 'true';
                return (r[col] ?? null) === v;
              }
              if (op === 'in') {
                return crudo
                  .replace(/^\(|\)$/g, '')
                  .split(',')
                  .includes(txt(r[col]));
              }
              return txt(r[col]) === crudo;
            };
            return neg ? (r: Row) => !base(r) : base;
          });
          preds.push((r) => conds.some((f) => f(r)));
          return api;
        },
        order(col: string, o?: { ascending?: boolean }) {
          q.orden.push([col, o?.ascending !== false]);
          return api;
        },
        range(d: number, h: number) {
          q.rango = [d, h];
          return api;
        },
        limit(n: number) {
          q.limite = n;
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
      log.push({
        tabla: `rpc:${nombre}`,
        op: 'rpc',
        texto: JSON.stringify(args),
        sel: '',
        filtros: [],
        orden: [],
        rango: null,
        limite: null,
        head: false,
        count: null,
      });
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
        error: { code: 'FAKE', message: `RPC prohibida en la hoja: ${nombre}` },
      });
    },
  };
  return {
    supabase: { service } as unknown as SupabaseService,
    log,
    /** Escrituras y RPC que NO son la sonda (deben quedar en []). */
    escrituras: () =>
      log.filter(
        (c) =>
          (c.op !== 'select' && c.op !== 'rpc') ||
          (c.op === 'rpc' && c.tabla !== 'rpc:regla_cobro_cubierto'),
      ),
  };
}

/** ¿Es la consulta de una SONDA de columna (`select(col).limit(1)`)? */
export function esSonda(c: ConsultaFake): boolean {
  return (
    c.op === 'select' &&
    c.limite === 1 &&
    /^[a-z_]+$/.test(c.sel) &&
    c.filtros.length === 0
  );
}

// =====================================================================
// FILAS REALES DE PROD (SELECT del 15-oct-2026). Veneno y bordes, rotulados.
// =====================================================================

export const U = {
  ITZI: '5391362f-e8cc-4287-95ef-739911fbf0e5',
  ALEJANDRO: 'c691cc8b-3034-4f04-a383-d0b25c1971ec',
  DIEGO: 'c4d0633d-a5e9-4764-8e54-03c7fb00f3b7',
  JIMMY: 'ca9564a1-eef0-4fdb-b4e9-beceaa5a2428',
  PABLO: 'e5aa04a8-ac24-446a-b41d-9af5917cd4f1',
} as const;

export const CTA = {
  HSBC_PESOS: '033efd4a-3cbc-4999-951f-6ec259c9791b',
  COMBUSTIBLE: '0752514c-6e08-455d-a1bd-d5ed4c7ca689',
  TARJETA_HSBC_PABLO: '0d270516-b97b-4a79-a339-a85f138c84eb',
  EJE_SCOTIA: '212add6c-c4e5-44cc-a30c-0635c0ab3036',
  HSBC_USD: '47d8fe90-8c9b-49e7-b648-31441f738131',
  SCOTIA_USD: '50c6f324-7490-4fbf-b327-452463a78312',
  PAYWISE: '51740293-2e8f-4f7c-81f8-71c4d105db10',
  YG: '5fab9fe9-39a2-49af-bf06-9664e8f2e018',
  AMEX_PABLO: '62120cbc-7217-4a79-8b2b-76d6ab086979',
  AFIRME: '6c9b0a81-8de2-4d83-b2e3-2b3676faf526',
  GASTOS_GNRAL: '76a931e0-7c06-47c6-a574-6c7d4a698c14',
  AMEX_ALE: '834fe175-bdc6-4825-ad5c-44179757413c',
  TARJETA_CREDITO_HSBC: 'a9d43a0b-69fc-4d60-bdbc-aa5a840e7b1e',
} as const;

const cuenta = (
  id: string,
  alias: string,
  banco: string,
  moneda: string,
  tipo: string,
  activa: boolean,
): Row => ({ id, alias, banco, moneda, tipo, activa });

export const CUENTAS: Row[] = [
  cuenta(CTA.HSBC_PESOS, 'HSBC Pesos', 'HSBC', 'MXN', 'BANCO', true),
  cuenta(CTA.COMBUSTIBLE, 'COMBUSTIBLE', 'Scotiabank', 'MXN', 'BANCO', true),
  cuenta(
    CTA.TARJETA_HSBC_PABLO,
    'Tarjeta HSBC Pablo',
    'HSBC',
    'MXN',
    'BANCO',
    false,
  ),
  cuenta(CTA.EJE_SCOTIA, 'EJE SCOTIA', 'Scotiabank', 'MXN', 'BANCO', true),
  cuenta(CTA.HSBC_USD, 'HSBC USD', 'HSBC', 'USD', 'BANCO', true),
  cuenta(CTA.SCOTIA_USD, 'SCOTIA USD', 'Scotiabank', 'USD', 'BANCO', false),
  cuenta(CTA.PAYWISE, 'Paywise', 'Paywise', 'MXN', 'PASARELA', true),
  cuenta(CTA.YG, 'YG', 'Scotiabank', 'MXN', 'BANCO', false),
  cuenta(
    CTA.AMEX_PABLO,
    'American Express Pablo',
    'American Express',
    'MXN',
    'BANCO',
    false,
  ),
  cuenta(CTA.AFIRME, 'afirme', 'afirme', 'MXN', 'BANCO', true),
  cuenta(CTA.GASTOS_GNRAL, 'GASTOS GNRAL', 'Scotiabank', 'MXN', 'BANCO', true),
  // VENENO: la única cuenta de prod con número capturado (aquí, de mentira).
  {
    ...cuenta(
      CTA.AMEX_ALE,
      'American Express Ale',
      'American Express',
      'MXN',
      'BANCO',
      true,
    ),
    numero_cuenta: 'VENENO-NUMERO-0000',
    clabe: 'VENENO-CLABE-000000',
  },
  cuenta(
    CTA.TARJETA_CREDITO_HSBC,
    'Tarjeta credito personal HSBC',
    'HSBC',
    'MXN',
    'BANCO',
    true,
  ),
];

export const USUARIOS: Row[] = [
  { id: U.ITZI, nombre: 'Itzi' },
  { id: U.ALEJANDRO, nombre: 'Alejandro Canales' },
  { id: U.DIEGO, nombre: 'Diego Ramírez' },
  { id: U.JIMMY, nombre: 'Jimmy Chi' },
  { id: U.PABLO, nombre: 'Pablo Canales' },
];

export const K = {
  MORENA_MIA: '31829315-7b9b-4747-ba63-f27bc90f3f5b',
  PALMA: 'ed044d7b-d510-4da8-a3ba-c11288d3fb2f',
  DIEGO_BELTRA: '9f842a8b-0b20-4879-8917-05c4ad219860',
  ACP: '275cb601-8bb9-48d3-867f-29baede59689',
  BEH_KAY: '4331f4ec-aeea-4e70-953b-590846aaa41a',
  JACOBO: '9860d53f-d47f-4494-9b1a-58efe051f249',
  ANDY: 'ad128023-1e71-43c5-a622-6878d8766af5',
  JANUARY: '36ba7a4d-cb36-4a0d-99e2-cbc8c18af3b1',
  THIS_IS_CZM: '5e56a8c4-eeda-4bef-888b-44901d6a01ec',
  NAVYFLEX: '4207781a-7975-45ce-818c-ecb81a8df6a1',
} as const;

export const CLIENTES: Row[] = [
  { id: K.MORENA_MIA, nombre: 'Morena Mia' },
  { id: K.PALMA, nombre: 'Palma' },
  { id: K.DIEGO_BELTRA, nombre: 'Diego Beltra' },
  { id: K.ACP, nombre: 'ACP' },
  { id: K.BEH_KAY, nombre: 'Beh Kay ' },
  { id: K.JACOBO, nombre: 'Jacobo Adrián Arzate Hop' },
  { id: K.ANDY, nombre: 'Andy de León' },
  { id: K.JANUARY, nombre: 'January Davila' },
  { id: K.THIS_IS_CZM, nombre: 'This Is Czm' },
  { id: K.NAVYFLEX, nombre: 'Navyflex' },
];

/** folio ⇒ [vuelo_id, cliente_id]. */
const VUELOS_REALES: Array<[number, string, string]> = [
  [198, '3c8a63bf-ba67-45f9-a238-25525a80cce5', K.MORENA_MIA],
  [223, 'fb8c9f91-2beb-48e7-ba6b-3476d3b8587c', K.MORENA_MIA],
  [226, 'c4e4673e-b6ae-4fd0-b987-cc9eaf5ee2f7', K.MORENA_MIA],
  [254, '09581163-d37e-45a9-90d0-9684458f17b7', K.PALMA],
  [255, '1a82bdee-bac5-49e0-8b66-603b8c86a5be', K.PALMA],
  [293, '538043ec-7cd3-46c8-802c-d2d2e1c91206', K.DIEGO_BELTRA],
  [295, '72ca2c0d-274f-43c7-a1a7-a143e47b3de4', K.ACP],
  [296, 'a3cea311-702b-41b8-a1d5-26761e7459e2', K.ACP],
  [297, 'dc204a2f-6342-43f1-9406-f76dc1302b97', K.ACP],
  [315, 'e3851d95-b022-4825-883f-1e81068712cb', K.BEH_KAY],
  [323, 'e20670f3-66cf-4a45-b0ab-9373512c912c', K.ACP],
  [332, '6f1825e3-0c54-45f1-bb66-d8f27a71fb7e', K.BEH_KAY],
  [343, '2ee3d4a5-0c90-4b29-89b3-3d28f45bb32d', K.ACP],
  [349, '43f64ec8-04c3-411d-a1eb-4f49accc9b77', K.JACOBO],
  [358, '2d393801-a664-4eef-8cbe-59da3ef8ad60', K.ANDY],
  [366, '478625c1-a849-4202-9b3a-65cc6083e6a2', K.ACP],
  [375, '423e468d-ffb8-4b87-a6da-d9b19e2e1d5f', K.JANUARY],
  [376, 'eb474572-8bda-469f-adca-db556f811d86', K.JANUARY],
  [379, '9ebdb0dc-33d5-4d8c-a077-2357cc406e55', K.PALMA],
  [380, 'a1fec1ba-833a-417e-9324-bb2f1b7094bd', K.PALMA],
  [383, '137d80a6-b553-41bb-bbf2-834a391618b5', K.THIS_IS_CZM],
  [404, '9b6d5be3-0756-4675-8ead-cfbf056b7c35', K.NAVYFLEX],
];

export const VUELO: Record<number, string> = Object.fromEntries(
  VUELOS_REALES.map(([f, id]) => [f, id]),
);

export const VUELOS: Row[] = VUELOS_REALES.map(([folio, id, cliente_id]) => ({
  id,
  folio,
  cliente_id,
  estado: 'COMPLETADO',
  fecha_vuelo: null,
}));

/** Cobros REALES (id ⇒ fila). */
export const C = {
  C198: '3426fd35-ba04-4bc8-be7d-ed9a9f8e2775',
  C223: 'd45a8387-e0f2-42ad-bcc7-226a45d1bbe0',
  C226: '7a3161a7-3169-4e10-aec2-b33c08edd2fe',
  C254: 'e6821245-f006-4dd4-8e2d-fcdbd62ef18c',
  C255: '910432ab-db0e-4d8e-935a-e757abd2432c',
  C293: 'ba71a50f-6f80-4412-82fe-ec0f97aec63e',
  C293_USD: '41502ace-2dca-4c77-8657-2cfdd04591b7',
  C295: '5a651256-19f2-4ea8-a61c-682a60c2749b',
  C296: 'c4143e99-295f-47d5-9534-a52a586ad621',
  C297: 'e8543fb6-26ea-4728-8422-2b0e1b886ad0',
  C315_1700A: '3643f03c-a3f7-45ec-bf29-03a1afc18774',
  C315: '46c6dae8-6751-4faa-8caa-b8d952817209',
  C315_1700B: 'abca82f3-ef73-4a19-b0df-1920d07eca05',
  C323: '4308757f-f811-4024-88a0-8b2415d5e521',
  C332: 'd7b0890c-9d0f-441f-a5cd-edd27fa50f0f',
  C343: '6732fcca-6829-4ca6-a71b-6a5617eeadbb',
  C349: 'b014ddbb-cebb-4e43-abcc-b1d28b1211e1',
  C358: '6276578b-e7bb-4925-a233-8e8cfd80c3b6',
  C366: '850a1da7-dff5-4d19-8738-96dbe3982d8b',
  C375: '074ab922-ecc5-41b6-b408-428068658945',
  C376: '3aca34ac-1ef9-448c-b484-dc88c854b95c',
  C379: '6a71d26c-c534-46e4-8953-956fa23c3da3',
  C380: '3924e3c4-ac1b-4eb4-bc01-2f387b7f7636',
  C383: 'f09f2120-a7f8-416b-983c-34b1b98c5b3b',
  C404: '40c762ab-93c8-4856-84ca-0e43f27b78f1',
} as const;

const cobro = (
  id: string,
  folio: number,
  monto: number,
  moneda: 'MXN' | 'USD',
  metodo_cobro: string,
  fecha_cobro: string,
  registrado_por: string,
  created_at: string,
  extra: Row = {},
): Row => ({
  id,
  vuelo_id: VUELO[folio],
  monto,
  moneda,
  metodo_cobro,
  comision_banco_monto: null,
  tc_usd_mxn: null,
  fecha_cobro,
  referencia: null,
  notas: null,
  cuenta_destino: null,
  registrado_por,
  created_at,
  cobro_grupo_id: null,
  ingreso_anticipo_id: null,
  // VENENO: jamás debe salir en la hoja.
  foto_voucher_url: `vouchers/VENENO-${folio}.jpg`,
  ...extra,
});

const MXN = 'MXN' as const;
const USD = 'USD' as const;

export const COBROS: Row[] = [
  cobro(
    C.C198,
    198,
    783,
    USD,
    'TRANSFERENCIA',
    '2026-09-10T17:00:00+00:00',
    U.ITZI,
    '2026-09-17T21:12:44.122414+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C223,
    223,
    812,
    USD,
    'TRANSFERENCIA',
    '2026-09-10T17:00:00+00:00',
    U.ITZI,
    '2026-09-17T21:14:16.291733+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C226,
    226,
    812,
    USD,
    'TRANSFERENCIA',
    '2026-09-10T17:00:00+00:00',
    U.ITZI,
    '2026-09-17T21:16:26.886371+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C254,
    254,
    27526.5,
    MXN,
    'TRANSFERENCIA',
    '2026-09-07T17:00:00+00:00',
    U.ITZI,
    '2026-09-14T20:26:13.449726+00:00',
    { tc_usd_mxn: 16.9498, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C255,
    255,
    27526.5,
    MXN,
    'TRANSFERENCIA',
    '2026-09-07T17:00:00+00:00',
    U.ITZI,
    '2026-09-14T20:27:29.514953+00:00',
    { tc_usd_mxn: 16.9498, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C293,
    293,
    12495,
    MXN,
    'PAYWISE',
    '2026-09-11T17:00:00+00:00',
    U.ITZI,
    '2026-09-21T16:43:40.081513+00:00',
    { comision_banco_monto: 624.76, tc_usd_mxn: 17, cuenta_destino: 'Paywise' },
  ),
  cobro(
    C.C293_USD,
    293,
    240,
    USD,
    'DOLARES',
    '2026-09-21T17:00:00+00:00',
    U.ITZI,
    '2026-09-21T16:44:00.477211+00:00',
  ),
  cobro(
    C.C295,
    295,
    1392,
    USD,
    'TRANSFERENCIA',
    '2026-09-22T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-09-24T21:32:24.6885+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C296,
    296,
    1392,
    USD,
    'TRANSFERENCIA',
    '2026-09-22T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-09-24T21:29:45.883083+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C297,
    297,
    1392,
    USD,
    'TRANSFERENCIA',
    '2026-09-22T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-09-24T21:33:50.312016+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C315_1700A,
    315,
    1700,
    MXN,
    'TRANSFERENCIA',
    '2026-09-15T17:00:00+00:00',
    U.ITZI,
    '2026-09-24T22:19:06.03753+00:00',
    { tc_usd_mxn: 17.15, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C315,
    315,
    68205.55,
    MXN,
    'TRANSFERENCIA',
    '2026-09-15T17:00:00+00:00',
    U.ITZI,
    '2026-09-24T22:19:27.067696+00:00',
    { tc_usd_mxn: 17.15, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C315_1700B,
    315,
    1700,
    MXN,
    'TRANSFERENCIA',
    '2026-09-15T17:00:00+00:00',
    U.DIEGO,
    '2026-10-14T21:21:49.025963+00:00',
    { tc_usd_mxn: 17.15, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C323,
    323,
    2697,
    USD,
    'TRANSFERENCIA',
    '2026-09-22T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-09-24T21:35:29.644547+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C332,
    332,
    977.45,
    MXN,
    'TRANSFERENCIA',
    '2026-09-15T17:00:00+00:00',
    U.ITZI,
    '2026-09-24T22:31:02.318945+00:00',
    { tc_usd_mxn: 17.15, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C343,
    343,
    2697,
    USD,
    'TRANSFERENCIA',
    '2026-10-06T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-10-07T17:18:45.141058+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C349,
    349,
    11440,
    MXN,
    'TRANSFERENCIA',
    '2026-09-25T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-09-26T18:34:08.462162+00:00',
    { comision_banco_monto: 572, tc_usd_mxn: 17.6, cuenta_destino: 'Paywise' },
  ),
  cobro(
    C.C358,
    358,
    41000.01,
    MXN,
    'PAYWISE',
    '2026-09-30T17:00:00+00:00',
    U.PABLO,
    '2026-09-30T18:32:20.385485+00:00',
    {
      comision_banco_monto: 2050,
      tc_usd_mxn: 17.59997,
      cuenta_destino: 'Paywise',
    },
  ),
  cobro(
    C.C366,
    366,
    2697,
    USD,
    'TRANSFERENCIA',
    '2026-10-06T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-10-07T17:21:01.386879+00:00',
    { cuenta_destino: 'HSBC Dólares' },
  ),
  cobro(
    C.C375,
    375,
    16343.59,
    MXN,
    'HSBC_LINK',
    '2026-10-02T17:00:00+00:00',
    U.ITZI,
    '2026-10-05T20:03:09.69733+00:00',
    {
      comision_banco_monto: 625.64,
      tc_usd_mxn: 18.069,
      cuenta_destino: 'HSBC Pesos',
      notas: 'Pago dos vuelos en uno, el otro es el 21 oct',
    },
  ),
  cobro(
    C.C376,
    376,
    16343.59,
    MXN,
    'HSBC_LINK',
    '2026-10-02T17:00:00+00:00',
    U.ITZI,
    '2026-10-05T20:07:07.983507+00:00',
    {
      comision_banco_monto: 625.64,
      tc_usd_mxn: 18.069,
      cuenta_destino: 'HSBC Pesos',
      notas: 'pago dos vuelos en uno, el otro es el 15 oct',
    },
  ),
  cobro(
    C.C379,
    379,
    29540.5,
    MXN,
    'TRANSFERENCIA',
    '2026-10-06T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-10-07T16:18:42.540003+00:00',
    { tc_usd_mxn: 18.189963, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C380,
    380,
    29540.5,
    MXN,
    'TRANSFERENCIA',
    '2026-10-06T17:00:00+00:00',
    U.ALEJANDRO,
    '2026-10-07T16:19:50.397292+00:00',
    { tc_usd_mxn: 18.189963, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C383,
    383,
    48004.2,
    MXN,
    'TRANSFERENCIA',
    '2026-10-08T17:00:00+00:00',
    U.ITZI,
    '2026-10-08T18:43:29.809678+00:00',
    { tc_usd_mxn: 18.1903, cuenta_destino: 'Scotiabank Pesos' },
  ),
  cobro(
    C.C404,
    404,
    63173.6,
    MXN,
    'TRANSFERENCIA',
    '2026-10-07T17:00:00+00:00',
    U.ITZI,
    '2026-10-08T18:56:14.812926+00:00',
    { tc_usd_mxn: 18, cuenta_destino: 'Scotiabank Pesos' },
  ),
];

export const EC = {
  SCOTIA_EJE_SEP: '1758cc58-7d78-4f73-966b-e7867803b8cc',
  SCOTIA_EJE_OCT: '2a7496a9-82c6-4c4b-b5c5-ecfcaa607b1a',
  HSBC_USD_SEP: '2f8f9af6-cfc5-43ad-94dd-01c14adb9723',
  HSBC_PESOS: '33a0519f-6c93-42ef-814c-c86f9229e8bc',
  HSBC_PESOS_SEP: '49299051-b2ef-4f76-926c-afae41180ef6',
  PAYWISE_26SEP: '4d3ac74f-b717-489c-9ad8-b2c8d7d44685',
  PAYWISE_24SEP: '530470fc-c363-4149-82b9-e296567151f4',
  PAYWISE_OCT: '68a461ec-85f4-43f1-8766-df8aa8880b2f',
  HSBC_USD: '76c6174c-6701-4f3f-83b6-3c77f36c648c',
  SCOTIA_COMBUS_6: 'caa0a50a-df3d-4df4-96e1-97845d8ae7e1',
} as const;

const archivo = (
  id: string,
  cuenta_bancaria_id: string,
  filename: string,
  movimientos_importados: number,
  created_at: string,
  created_by: string,
): Row => ({
  id,
  cuenta_bancaria_id,
  filename,
  formato: 'pdf',
  movimientos_importados,
  created_at,
  created_by,
  // VENENO: la descarga es POST estados-cuenta/:id/url, jamás la ruta.
  storage_path: `estados-cuenta/VENENO/${id}.pdf`,
});

export const ESTADOS_CUENTA: Row[] = [
  archivo(
    EC.SCOTIA_EJE_SEP,
    CTA.EJE_SCOTIA,
    'scotia eje sep.pdf',
    98,
    '2026-10-06T15:22:46.413405+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.SCOTIA_EJE_OCT,
    CTA.EJE_SCOTIA,
    'scotia eje.pdf',
    17,
    '2026-10-08T18:17:49.035693+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.HSBC_USD_SEP,
    CTA.HSBC_USD,
    'HSBC USD sep.pdf',
    5,
    '2026-10-06T15:26:37.373389+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.HSBC_PESOS,
    CTA.HSBC_PESOS,
    'HSBC PESOS.pdf',
    10,
    '2026-10-08T18:21:26.261386+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.HSBC_PESOS_SEP,
    CTA.HSBC_PESOS,
    'HSBC PESOS sep.pdf',
    11,
    '2026-10-06T15:25:57.088454+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.PAYWISE_26SEP,
    CTA.PAYWISE,
    'Reporte de Movimientos Septiembre-2026.pdf',
    1,
    '2026-09-26T18:04:00.269845+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.PAYWISE_24SEP,
    CTA.PAYWISE,
    'Reporte de Movimientos Septiembre-2026.pdf',
    34,
    '2026-09-24T19:46:03.233773+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.PAYWISE_OCT,
    CTA.PAYWISE,
    'Reporte de Movimientos paywise Septiembre-2026.pdf',
    12,
    '2026-10-06T15:28:57.993637+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.HSBC_USD,
    CTA.HSBC_USD,
    'HSBC USD.pdf',
    6,
    '2026-10-08T18:22:00.088476+00:00',
    U.ALEJANDRO,
  ),
  archivo(
    EC.SCOTIA_COMBUS_6,
    CTA.COMBUSTIBLE,
    'scotia combus (6).pdf',
    75,
    '2026-09-29T20:35:24.229074+00:00',
    U.JIMMY,
  ),
];

export const M = {
  LOTE_55053: '28340088-75bf-4279-890f-ea0898d17f1c',
  MORENA_2407: '91633c53-c8c7-422f-b6bc-81f93d32347e',
  DIDI_78: 'abcf6f05-e560-4d33-ae1e-d0248bd40c6e',
  PAYWISE_293: '5b8ef8f4-0655-4a41-88e6-01a73a626549',
  SPEI_1700_B: '32dd3b1d-e1da-4263-9edb-245e8b04bd1b',
  LOTE_69183: '8a7eff81-6b8c-469e-a74d-2b0f4b631b08',
  SPEI_1700_A: 'a7e31d9d-25de-48bd-b74f-55155e459df6',
  ACP_6873: 'e06ff209-1526-4ee5-9c28-6bbb0c7187fb',
  PAYWISE_349: '80f34938-5e89-4fcd-ab59-6708d13a3675',
  PAYWISE_358: 'b8ed1d61-f8c5-4f6f-9d7f-d87db4072b30',
  JANUARY_31435: '51098a7b-62ee-48ae-9929-0e5c5534da21',
  ACP_5394: '1f5f9c97-8fbd-4d06-99d7-0d69b76b1499',
  PALMA_59081: '31e9dd74-21e2-465f-9a9e-6a1c038d683f',
  NAVYFLEX_63173: '8c3501a3-bd77-4dbe-be7c-c461a37f77e5',
  CZM_48004: '9882fc4f-75a9-459c-88b3-7326622db4f6',
  ING4_46550: '26a99d36-baf8-4014-9f74-19b48b6458cf',
  ING7_4210: '24c9ef49-75b6-4323-8e45-36cb589c18e2',
  SIN_ARCHIVO_1811: '9cc888a3-87c2-4b05-b3ae-0425ca7ef6a9',
} as const;

const abono = (
  id: string,
  cuenta_bancaria_id: string,
  fecha: string,
  monto: number,
  descripcion: string,
  referencia: string | null,
  created_at: string,
  created_by: string,
  estado_cuenta_id: string | null,
  extra: Row = {},
): Row => ({
  id,
  cuenta_bancaria_id,
  fecha,
  tipo: 'ABONO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion,
  referencia,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  reverso_de_id: null,
  cobros_n: 0,
  gastos_n: 0,
  orden_archivo: null,
  origen: 'IMPORTADO',
  notas: null,
  created_at,
  created_by,
  estado_cuenta_id,
  ...extra,
});

export const MOVIMIENTOS: Row[] = [
  abono(
    M.LOTE_55053,
    CTA.EJE_SCOTIA,
    '2026-09-08',
    55053,
    'Depositos SBC Camara Presentada No.6790748',
    '00000000001300356497',
    '2026-10-06T15:22:46.58996+00:00',
    U.ALEJANDRO,
    EC.SCOTIA_EJE_SEP,
    { conciliado: true, cobros_n: 2 },
  ),
  abono(
    M.MORENA_2407,
    CTA.HSBC_USD,
    '2026-09-10',
    2407,
    'MORENA MIA 0100926, SPID',
    '5231 A2000 00804',
    '2026-10-06T15:26:37.49328+00:00',
    U.ALEJANDRO,
    EC.HSBC_USD_SEP,
  ),
  abono(
    M.DIDI_78,
    CTA.COMBUSTIBLE,
    '2026-09-10',
    78,
    'DLO DIDI RIDES MX (AJUSTE)',
    '00005579209156174929 REF. 9156174929 AUT. 085488',
    '2026-09-29T20:35:24.413103+00:00',
    U.JIMMY,
    EC.SCOTIA_COMBUS_6,
    { conciliado: true, ingreso_id: 'ffb57607-77e4-4334-8ee9-94afdba75f91' },
  ),
  abono(
    M.PAYWISE_293,
    CTA.PAYWISE,
    '2026-09-11',
    11870.24,
    'DIEGO FRANCISCO,BELTRAN/COLLADO : dbc cozcan 20sep',
    null,
    '2026-09-24T19:46:03.346932+00:00',
    U.ALEJANDRO,
    EC.PAYWISE_24SEP,
    { conciliado: true, cobro_id: C.C293, cobros_n: 1 },
  ),
  abono(
    M.SPEI_1700_B,
    CTA.EJE_SCOTIA,
    '2026-09-15',
    1700,
    'TRANSF INTERBANCARIA SPEI',
    '00000000000000150926',
    '2026-10-06T15:22:46.58996+00:00',
    U.ALEJANDRO,
    EC.SCOTIA_EJE_SEP,
    { conciliado: true, cobro_id: C.C315_1700B, cobros_n: 1 },
  ),
  abono(
    M.LOTE_69183,
    CTA.EJE_SCOTIA,
    '2026-09-15',
    69183,
    'TRANSF INTERBANCARIA SPEI',
    '00000000000000150926',
    '2026-10-06T15:22:46.58996+00:00',
    U.ALEJANDRO,
    EC.SCOTIA_EJE_SEP,
    { conciliado: true, cobros_n: 2 },
  ),
  abono(
    M.SPEI_1700_A,
    CTA.EJE_SCOTIA,
    '2026-09-15',
    1700,
    'TRANSF INTERBANCARIA SPEI',
    '00000000000000150926',
    '2026-10-06T15:22:46.58996+00:00',
    U.ALEJANDRO,
    EC.SCOTIA_EJE_SEP,
    { conciliado: true, cobro_id: C.C315_1700A, cobros_n: 1 },
  ),
  abono(
    M.ACP_6873,
    CTA.HSBC_USD,
    '2026-09-22',
    6873,
    '5123 AEROCHARTER FA0415 A0417 Y 0220926, SPID',
    '5231 A2000 00804',
    '2026-10-06T15:26:37.49328+00:00',
    U.ALEJANDRO,
    EC.HSBC_USD_SEP,
  ),
  abono(
    M.PAYWISE_349,
    CTA.PAYWISE,
    '2026-09-25',
    10868,
    'JACOBO ADRIAN,ARZATE/HOP : vuelo',
    null,
    '2026-09-26T18:04:00.390934+00:00',
    U.ALEJANDRO,
    EC.PAYWISE_26SEP,
  ),
  abono(
    M.PAYWISE_358,
    CTA.PAYWISE,
    '2026-09-30',
    38950,
    'Vuelo Andy De Leon 29 septiembre 2026',
    null,
    '2026-10-06T15:28:58.14114+00:00',
    U.ALEJANDRO,
    EC.PAYWISE_OCT,
    { conciliado: true, cobro_id: C.C358, cobros_n: 1 },
  ),
  abono(
    M.JANUARY_31435,
    CTA.HSBC_PESOS,
    '2026-10-05',
    31435.91,
    'TRANSF REC HSBCNET DEP TPV 9576662',
    'A2000 09004',
    '2026-10-08T18:21:26.403745+00:00',
    U.ALEJANDRO,
    EC.HSBC_PESOS,
  ),
  abono(
    M.ACP_5394,
    CTA.HSBC_USD,
    '2026-10-06',
    5394,
    '5165 AEROCHARTER F A0432 A0436 0061026, SPID',
    'A2000 00804',
    '2026-10-08T18:22:00.183286+00:00',
    U.ALEJANDRO,
    EC.HSBC_USD,
  ),
  abono(
    M.PALMA_59081,
    CTA.EJE_SCOTIA,
    '2026-10-06',
    59081,
    'Depositos SBC Camara Presentada No.6790754',
    '00000000013059240084',
    '2026-10-08T18:17:49.143525+00:00',
    U.ALEJANDRO,
    EC.SCOTIA_EJE_OCT,
  ),
  abono(
    M.NAVYFLEX_63173,
    CTA.EJE_SCOTIA,
    '2026-10-07',
    63173.6,
    'TRANSF INTERBANCARIA SPEI Pago Charter /INBURSA',
    '00000000000000100726',
    '2026-10-08T18:17:49.143525+00:00',
    U.ALEJANDRO,
    EC.SCOTIA_EJE_OCT,
  ),
  abono(
    M.CZM_48004,
    CTA.EJE_SCOTIA,
    '2026-10-08',
    48004.2,
    'TRANSF INTERBANCARIA SPEI Folio 383 /JP MORGAN',
    '00000000000090272254',
    '2026-10-08T18:17:49.143525+00:00',
    U.ALEJANDRO,
    EC.SCOTIA_EJE_OCT,
  ),
  abono(
    M.ING4_46550,
    CTA.EJE_SCOTIA,
    '2026-09-04',
    46550.8,
    'TRANSF INTERBANCARIA SPEI',
    '00000000000000040926',
    '2026-10-06T15:22:46.58996+00:00',
    U.ALEJANDRO,
    EC.SCOTIA_EJE_SEP,
    { conciliado: true, ingreso_id: '21d37735-97e6-46da-ae1f-10b0d197af79' },
  ),
  abono(
    M.ING7_4210,
    CTA.HSBC_PESOS,
    '2026-09-29',
    4210,
    'TRANSF REC HSBCNET DEP TPV 9561420',
    'A2000 09004',
    '2026-10-06T15:25:57.272357+00:00',
    U.ALEJANDRO,
    EC.HSBC_PESOS_SEP,
    { conciliado: true, ingreso_id: '15c98281-d60e-4980-8646-424c31ef8bbe' },
  ),
  // Importado SIN archivo el 16-jul-2026 (17-jul en UTC) por Jimmy Chi.
  abono(
    M.SIN_ARCHIVO_1811,
    CTA.GASTOS_GNRAL,
    '2026-07-13',
    1811.59,
    'Transf Interbancaria SPEI reembolso',
    '2026071340014TRAPP020471148450',
    '2026-07-17T00:34:09.441194+00:00',
    U.JIMMY,
    null,
  ),
];

/**
 * SINTÉTICOS (rotulados): CARGOS con las fechas REALES del primer y último
 * movimiento de cada cuenta activa en prod (14-oct-2026), para que
 * `ultimos_movimientos` diga lo del ejemplo D de la spec. Son cargos: no
 * cuentan en «el cruce no corrió» (solo abonos).
 */
export const BORDES_IMPORTADOS: Row[] = (
  [
    [CTA.COMBUSTIBLE, '2026-07-01'],
    [CTA.COMBUSTIBLE, '2026-10-12'],
    [CTA.EJE_SCOTIA, '2026-09-01'],
    [CTA.EJE_SCOTIA, '2026-10-12'],
    [CTA.GASTOS_GNRAL, '2026-07-01'],
    [CTA.GASTOS_GNRAL, '2026-10-12'],
    [CTA.HSBC_PESOS, '2026-09-01'],
    [CTA.HSBC_PESOS, '2026-10-07'],
    [CTA.HSBC_USD, '2026-09-01'],
    [CTA.PAYWISE, '2026-09-01'],
  ] as Array<[string, string]>
).map(([cuentaId, fecha], i) => ({
  ...abono(
    `b0rde000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    cuentaId,
    fecha,
    -1,
    'BORDE SINTÉTICO',
    null,
    '2026-10-13T00:00:00+00:00',
    U.ALEJANDRO,
    null,
  ),
  tipo: 'CARGO',
  conciliado: true,
}));

/** La puente REAL (las partes de esos abonos). */
export const PARTES: Row[] = [
  {
    movimiento_id: M.LOTE_55053,
    cobro_id: C.C255,
    monto_parte: 27526.5,
    created_at: '2026-10-14T21:24:23.298278+00:00',
    created_by: U.DIEGO,
  },
  {
    movimiento_id: M.LOTE_55053,
    cobro_id: C.C254,
    monto_parte: 27526.5,
    created_at: '2026-10-13T16:51:24.805037+00:00',
    created_by: U.ALEJANDRO,
  },
  {
    movimiento_id: M.SPEI_1700_B,
    cobro_id: C.C315_1700B,
    monto_parte: 1700,
    created_at: '2026-10-14T21:21:49.025963+00:00',
    created_by: U.DIEGO,
  },
  {
    movimiento_id: M.PAYWISE_293,
    cobro_id: C.C293,
    monto_parte: 11870.24,
    created_at: '2026-09-24T19:46:09.818919+00:00',
    created_by: U.ALEJANDRO,
  },
  {
    movimiento_id: M.LOTE_69183,
    cobro_id: C.C315,
    monto_parte: 68205.55,
    created_at: '2026-10-06T15:23:02.876349+00:00',
    created_by: U.ALEJANDRO,
  },
  {
    movimiento_id: M.LOTE_69183,
    cobro_id: C.C332,
    monto_parte: 977.45,
    created_at: '2026-10-14T21:21:49.025963+00:00',
    created_by: U.DIEGO,
  },
  {
    movimiento_id: M.SPEI_1700_A,
    cobro_id: C.C315_1700A,
    monto_parte: 1700,
    created_at: '2026-10-13T20:25:55.969339+00:00',
    created_by: U.ALEJANDRO,
  },
  {
    movimiento_id: M.PAYWISE_358,
    cobro_id: C.C358,
    monto_parte: 38950,
    created_at: '2026-10-06T15:29:01.814086+00:00',
    created_by: U.ALEJANDRO,
  },
];

export const ING = {
  ING2: 'a24bf9ca-4e50-40c6-98e4-96fb632f866e',
  ING3: 'ffb57607-77e4-4334-8ee9-94afdba75f91',
  ING4: '21d37735-97e6-46da-ae1f-10b0d197af79',
  ING7: '15c98281-d60e-4980-8646-424c31ef8bbe',
} as const;

const ingreso = (
  id: string,
  folio: number,
  categoria: string,
  fecha: string,
  descripcion: string,
  monto: number,
  metodo: string,
  cuenta_bancaria_id: string | null,
  pagador: string,
  created_by: string,
  created_at: string,
): Row => ({
  id,
  folio,
  categoria,
  fecha,
  descripcion,
  monto,
  comision_monto: null,
  moneda: 'MXN',
  tc_usd_mxn: null,
  metodo,
  cuenta_bancaria_id,
  referencia: null,
  pagador,
  cliente_id: null,
  vuelo_id: null,
  aeronave_id: null,
  gasto_id: null,
  created_by,
  created_at,
  updated_at: created_at,
  deleted_at: null,
  deleted_by: null,
  motivo_baja: null,
  // VENENO: jamás en la hoja.
  archivo_path: `ingresos/VENENO/${id}.pdf`,
  notas: 'VENENO: notas crudas del ingreso',
});

export const INGRESOS: Row[] = [
  ingreso(
    ING.ING2,
    2,
    'REEMBOLSO_DEVOLUCION',
    '2026-09-22',
    'Reembolso Facturas Jimmy para efectivo',
    250000,
    'EFECTIVO',
    null,
    'Jimmy Chi',
    U.PABLO,
    '2026-09-26T17:21:47.908558+00:00',
  ),
  ingreso(
    ING.ING3,
    3,
    'OTRO_INGRESO',
    '2026-09-10',
    'DLO DIDI RIDES MX (AJUSTE)',
    78,
    'TRANSFERENCIA',
    CTA.COMBUSTIBLE,
    'didi',
    U.ALEJANDRO,
    '2026-10-12T22:57:31.939317+00:00',
  ),
  ingreso(
    ING.ING4,
    4,
    'REEMBOLSO_DEVOLUCION',
    '2026-09-04',
    'TRANSF INTERBANCARIA SPEI',
    46550.8,
    'TRANSFERENCIA',
    CTA.EJE_SCOTIA,
    'angel alvarez',
    U.ALEJANDRO,
    '2026-10-13T15:42:17.817222+00:00',
  ),
  ingreso(
    ING.ING7,
    7,
    'INGRESO_BANCARIO',
    '2026-09-29',
    'TRANSF REC HSBCNET DEP TPV 9561420',
    4210,
    'HSBC_LINK',
    CTA.HSBC_PESOS,
    'incognito',
    U.ALEJANDRO,
    '2026-10-14T22:43:25.571755+00:00',
  ),
];

export const BITACORA: Row[] = [
  {
    id: '05801e11-dc84-4b9e-a770-7aa38267778f',
    ingreso_id: ING.ING4,
    accion: 'CONCILIAR',
    actor_id: U.ALEJANDRO,
    created_at: '2026-10-13T15:42:18.595968+00:00',
    diff: { por: 'NETO', movimiento_id: M.ING4_46550 },
    snapshot: { veneno: 'snapshot crudo' },
  },
  {
    id: '438e4580-235d-4dab-8748-1f7a22f7a568',
    ingreso_id: ING.ING7,
    accion: 'CONCILIAR',
    actor_id: U.ALEJANDRO,
    created_at: '2026-10-14T22:43:26.093976+00:00',
    diff: { por: 'NETO', movimiento_id: M.ING7_4210 },
    snapshot: null,
  },
  {
    id: 'cd309253-35de-4557-9bac-4c76c08d0f54',
    ingreso_id: ING.ING3,
    accion: 'CONCILIAR',
    actor_id: U.ALEJANDRO,
    created_at: '2026-10-12T22:57:32.606618+00:00',
    diff: { por: 'NETO', movimiento_id: M.DIDI_78 },
    snapshot: null,
  },
];

/** El mundo de prod (copias profundas: cada spec puede mutarlo). */
export function mundoProd(extra: Partial<Tablas> = {}): Tablas {
  return structuredClone({
    cuenta_bancaria: CUENTAS,
    usuario: USUARIOS,
    cliente: CLIENTES,
    vuelo: VUELOS,
    cobro_vuelo: COBROS,
    cobro_grupo: [],
    vuelo_grupo: [],
    estado_cuenta_archivo: ESTADOS_CUENTA,
    movimiento_bancario: [...MOVIMIENTOS, ...BORDES_IMPORTADOS],
    movimiento_bancario_cobro: PARTES,
    ingreso: INGRESOS,
    ingreso_bitacora: BITACORA,
    conciliacion_clasificacion: [],
    aeronave: [],
    ...extra,
  });
}
