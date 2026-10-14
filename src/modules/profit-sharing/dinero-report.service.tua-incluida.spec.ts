// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { DineroReportService } from './dinero-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { DineroXlsxPayload } from '../pyservices/pyservices.service';

/**
 * LIBRO DINERO con la TUA de la OFICINA (13-oct-2026, TUA sistémica,
 * invariante 66): el egreso «tuas pagadas» de «otros ingresos» sale de la
 * fuente única `trasladosPagadosDeGasto` — la TUA fijada manda sobre la
 * lectura de la IA, un 0 la anula y una categoría de EMPRESA nunca la
 * separa. Los goldens de `dinero-report.service.ingresos.spec` y
 * `.pago-vendedor.spec` (mundo sin la columna) siguen intactos.
 */
type Fila = Record<string, unknown>;

const AV = 'av-1';
const V1 = 'v-1';
const DESDE = '2026-10-01';
const HASTA = '2026-10-31';
const DIA = '2026-10-06';

function valorEn(f: Fila, col: string): unknown {
  return col.split('.').reduce<unknown>((acc, k) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    const v = (acc as Record<string, unknown>)[k];
    return Array.isArray(v) ? (v[0] as unknown) : v;
  }, f);
}

function cmp(a: unknown, b: unknown): number {
  const iso = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  if (iso(a) || iso(b)) {
    const na = Date.parse(String(a));
    const nb = Date.parse(String(b));
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const txt = (v: unknown) =>
    v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  const sa = txt(a);
  const sb = txt(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function partirOr(cond: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of cond) {
    if (ch === '(') nivel += 1;
    if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) {
      out.push(actual);
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (actual) out.push(actual);
  return out;
}

/** Mini-PostgREST en memoria; `sinMigracion` = sin `gasto.tua_incluida`. */
function fakeSupabase(
  tablas: Record<string, Fila[]>,
  opts: { sinMigracion?: boolean } = {},
) {
  const selects: Array<{ tabla: string; cols: string }> = [];
  const from = (tabla: string) => {
    let filas = [...(tablas[tabla] ?? [])];
    let error: { code: string; message: string } | null = null;
    const filtrar = (fn: (f: Fila) => boolean) => {
      filas = filas.filter(fn);
      return q;
    };
    const cumple = (f: Fila, cond: string): boolean => {
      const m = /^([^.]+)\.([a-z]+)\.(.*)$/.exec(cond);
      if (!m) return false;
      const [, col, op, raw] = m;
      const v = valorEn(f, col);
      if (op === 'is') return (v ?? null) === (raw === 'null' ? null : raw);
      if (op === 'eq') return String(v) === raw;
      if (op === 'neq') return String(v) !== raw;
      if (op === 'in') {
        return raw
          .replace(/^\(|\)$/g, '')
          .split(',')
          .includes(String(v));
      }
      return false;
    };
    const q: Record<string, unknown> = {
      select: (cols?: string) => {
        selects.push({ tabla, cols: String(cols ?? '') });
        if (opts.sinMigracion && tabla === 'gasto' && cols === 'tua_incluida') {
          error = {
            code: '42703',
            message: 'column gasto.tua_incluida does not exist',
          };
        }
        return q;
      },
      eq: (c: string, v: unknown) => filtrar((f) => valorEn(f, c) === v),
      neq: (c: string, v: unknown) => filtrar((f) => valorEn(f, c) !== v),
      is: (c: string, v: unknown) =>
        filtrar((f) => (valorEn(f, c) ?? null) === v),
      in: (c: string, arr: unknown[]) =>
        filtrar((f) => arr.includes(valorEn(f, c))),
      or: (cond: string) =>
        filtrar((f) => partirOr(cond).some((c) => cumple(f, c))),
      gte: (c: string, v: unknown) =>
        filtrar((f) => cmp(valorEn(f, c), v) >= 0),
      lte: (c: string, v: unknown) =>
        filtrar((f) => cmp(valorEn(f, c), v) <= 0),
      gt: (c: string, v: unknown) => filtrar((f) => cmp(valorEn(f, c), v) > 0),
      lt: (c: string, v: unknown) => filtrar((f) => cmp(valorEn(f, c), v) < 0),
      not: (c: string, op: string, v: unknown) =>
        op === 'is' && v === null
          ? filtrar((f) => (valorEn(f, c) ?? null) !== null)
          : q,
      order: (c: string, o?: { ascending?: boolean }) => {
        const dir = o?.ascending === false ? -1 : 1;
        filas.sort((a, b) => dir * cmp(valorEn(a, c), valorEn(b, c)));
        return q;
      },
      limit: (n: number) => {
        filas = filas.slice(0, n);
        return q;
      },
      range: (a: number, b: number) => {
        filas = filas.slice(a, b + 1);
        return q;
      },
      maybeSingle: () =>
        Promise.resolve(
          error
            ? { data: null, error }
            : { data: filas[0] ?? null, error: null },
        ),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(
          error ? { data: null, error } : { data: filas, error: null },
        ).then(res, rej),
    };
    return q;
  };
  return {
    supabase: { service: { from } } as unknown as SupabaseService,
    selects,
  };
}

const LECTURA_383 = {
  conceptos: [
    { concepto: 'Operaciones', monto: 1365.64 },
    { concepto: 'Autobuses', monto: 559.63 },
  ],
};
const LECTURA_TARIFA_TUA = {
  conceptos: [
    { concepto: 'Operaciones', monto: 1365.64 },
    { concepto: 'Tarifa TUA', monto: 559.63 },
  ],
};

/** Un vuelo de octubre que cobró TUAS (100 USD a K 20 = $2,000 MXN). */
function mundo(gasto: Fila): Record<string, Fila[]> {
  return {
    aeronave: [
      {
        id: AV,
        matricula: 'XB-TST',
        modelo: 'C206',
        color_calendario: '#3B82F6',
      },
    ],
    cliente: [{ id: 'cli-1', nombre: 'Maqar' }],
    vuelo: [
      {
        id: V1,
        folio: 383,
        cliente_id: 'cli-1',
        aeronave_id: AV,
        estado: 'COMPLETADO',
        es_externo: false,
        fecha_vuelo: `${DIA}T15:00:00+00:00`,
        tiempo_cobrable_hr: 2,
        tarifa_hora_usd: 1000,
        iva_usd: 0,
        iva_pct: 0,
        monto_total_usd: 2100,
        monto_total_mxn: 42000,
        tc_usd_mxn: 20,
        cobrado: false,
        calculo_snapshot: null,
        subtotal_vuelo_usd: 2000,
        ajuste_final_usd: 0,
        comision_vendedor_usd: 0,
        comision_vendedor_nombre: null,
        tuas_usd: 100,
        extras_total_usd: 0,
        viaticos_pernocta_usd: 0,
        cliente: { nombre: 'Maqar' },
      },
    ],
    escala: [
      {
        id: 'e-1',
        vuelo_id: V1,
        orden: 1,
        aeronave_id: null,
        cancelada_at: null,
        taco_salida: 100,
        taco_llegada: 102,
        solo_operativa: false,
        es_ferry: false,
        origen_iata: 'CUN',
        destino_iata: 'MID',
        es_sobrevuelo: false,
        tipo_parada: 'NORMAL',
        pasajeros: 3,
      },
    ],
    cobro_vuelo: [],
    factura: [],
    gasto: [
      {
        aeronave_id: AV,
        vuelo_id: V1,
        escala_id: null,
        categoria: 'OPERACIONES',
        monto: '1925.27',
        propina: '0.00',
        moneda: 'MXN',
        tc_gasto: null,
        litros: null,
        fecha_gasto: DIA,
        notas: 'ASUR CUN',
        lugar: null,
        proveedor: null,
        vuelo: { folio: 383 },
        id: 'g-asur',
        valor_ia_extraido: LECTURA_383,
        ...gasto,
      },
    ],
    gasto_reparto: [],
    aeronave_socio: [],
    aeropuerto: [],
    usuario: [],
    movimiento_bancario: [],
    ingreso: [],
  };
}

type Privado = {
  buildPayload: (desde: string, hasta: string) => Promise<DineroXlsxPayload>;
};

async function libro(gasto: Fila, opts: { sinMigracion?: boolean } = {}) {
  const f = fakeSupabase(mundo(gasto), opts);
  const service = new DineroReportService(f.supabase, {} as never);
  const p = await (service as unknown as Privado).buildPayload(DESDE, HASTA);
  return { p, selects: f.selects };
}

/** Las filas de «otros ingresos» con egreso de TUA. */
const tuasPagadas = (p: DineroXlsxPayload) =>
  p.otros_ingresos.filter((f) =>
    /tuas pagadas/i.test(String(f.concepto_egreso ?? '')),
  );

describe('Libro Dinero — TUA de la oficina (13-oct-2026)', () => {
  it('control: el renglón «Tarifa TUA» de la IA ⇒ egreso 559.63 apareado con la línea «tuas»', async () => {
    const { p } = await libro({ valor_ia_extraido: LECTURA_TARIFA_TUA });
    expect(tuasPagadas(p)).toHaveLength(1);
    expect(tuasPagadas(p)[0]).toMatchObject({
      concepto_ingreso: 'tuas',
      ingreso_mxn: 2000,
      egreso_mxn: 559.63,
    });
  });

  it('TUA fijada 0 ⇒ desaparece el egreso «tuas pagadas» (la línea «tuas» queda sin egreso)', async () => {
    const { p } = await libro({
      valor_ia_extraido: LECTURA_TARIFA_TUA,
      tua_incluida: '0.00',
    });
    expect(tuasPagadas(p)).toHaveLength(0);
    const linea = p.otros_ingresos.find((f) => f.concepto_ingreso === 'tuas');
    expect(linea).toMatchObject({ egreso_mxn: null, remanente_mxn: 2000 });
  });

  it('TUA fijada 700 sobre el #383 («Autobuses») ⇒ egreso 700 apareado con la línea «tuas»', async () => {
    const { p } = await libro({ tua_incluida: '700.00' });
    expect(tuasPagadas(p)).toHaveLength(1);
    expect(tuasPagadas(p)[0]).toMatchObject({
      concepto_ingreso: 'tuas',
      egreso_mxn: 700,
      remanente_mxn: 1300,
    });
  });

  it('en una categoría de EMPRESA (OTRO) ⇒ 0: ya vive entera en «otros gastos»', async () => {
    const { p } = await libro({ categoria: 'OTRO', tua_incluida: '700.00' });
    expect(tuasPagadas(p)).toHaveLength(0);
  });

  it('sin la migración ⇒ la consulta de gastos de los vuelos NO nombra tua_incluida', async () => {
    const con = await libro({});
    const sin = await libro({}, { sinMigracion: true });
    const nombran = (s: Array<{ tabla: string; cols: string }>) =>
      s.filter((x) => x.cols !== 'tua_incluida' && /tua_incluida/.test(x.cols));
    expect(nombran(con.selects)).toHaveLength(1);
    expect(nombran(sin.selects)).toHaveLength(0);
    // Y el libro es el mismo (sin columna ni señal, nada cambia).
    expect(JSON.stringify({ ...sin.p, generado: 'X' })).toBe(
      JSON.stringify({ ...con.p, generado: 'X' }),
    );
  });
});
