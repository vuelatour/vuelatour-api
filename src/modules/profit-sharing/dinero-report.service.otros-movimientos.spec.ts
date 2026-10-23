// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { DineroReportService } from './dinero-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { DineroXlsxPayload } from '../pyservices/pyservices.service';

// CIERRE DE MES (invariante 89): este spec congela la conducta SIN la
// migración 20261016000004; la conducta con la migración vive en los specs
// `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

/**
 * LIBRO DINERO — «Otros movimientos (VuelaTour)» como gasto (23-oct-2026,
 * API 0.0.106, invariante 107): espejo del TUA pagado. Con vuelo, una fila
 * de SOLO-egreso por gasto en «Otros ingresos» del vuelo (ingreso null ⇒ las
 * utilidades no cambian); sin vuelo, se LISTA en «otros gastos» sin sumar al
 * acumulado ni acreditarse a ningún avión (como «tuas sin vuelo»).
 */
type Fila = Record<string, unknown>;

const AV = 'av-1';
const V1 = 'v-1';
const DESDE = '2026-09-01';
const HASTA = '2026-09-30';
const DIA = '2026-09-10';

/** Valor de una columna, con soporte de rutas embebidas ("vuelo.folio"). */
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

/** Separa las condiciones de un `.or(...)` sin romper los `in.(A,B)`. */
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

/** Mini-PostgREST en memoria, con `.or(...)` (la hoja «otros gastos» lo usa). */
function fakeSupabase(tablas: Record<string, Fila[]>): SupabaseService {
  const from = (tabla: string) => {
    let filas = [...(tablas[tabla] ?? [])];
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
      select: () => q,
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
      order: (c: string, opts?: { ascending?: boolean }) => {
        const dir = opts?.ascending === false ? -1 : 1;
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
        Promise.resolve({ data: filas[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: filas, error: null }).then(res, rej),
    };
    return q;
  };
  return { service: { from } } as unknown as SupabaseService;
}

const gastoBase = {
  aeronave_id: null,
  vuelo_id: null,
  escala_id: null,
  moneda: 'MXN',
  tc_gasto: null,
  litros: null,
  propina: null,
  valor_ia_extraido: null,
  fecha_gasto: DIA,
  notas: null,
  lugar: null,
  medio_pago: 'TRANSFERENCIA',
  proveedor: null,
  vuelo: null,
};

/** Ligado al vuelo #501 (el embebido `vuelo` alimenta la referencia). */
const conVuelo = { vuelo_id: V1, vuelo: { folio: 501 } };

const OM_VUELO: Fila = {
  ...gastoBase,
  ...conVuelo,
  id: 'g-om-1',
  categoria: 'OTROS_MOVIMIENTOS',
  monto: 1250,
  fecha_gasto: '2026-09-12',
  notas: 'Viáticos de pernocta pagados al piloto',
  medio_pago: 'EFECTIVO_EMPRESA',
  proveedor: { nombre: 'Hotel Xcaret' },
};
const CONCEPTO_OM_VUELO =
  'Viáticos de pernocta pagados al piloto · Hotel Xcaret (efectivo de la empresa)';
const OM_VUELO_2: Fila = {
  ...gastoBase,
  ...conVuelo,
  id: 'g-om-2',
  categoria: 'OTROS_MOVIMIENTOS',
  monto: 300,
  fecha_gasto: '2026-09-11',
  notas: 'Propina handling',
  lugar: 'CUN',
};
const TUAS_VUELO: Fila = {
  ...gastoBase,
  ...conVuelo,
  id: 'g-tuas',
  categoria: 'TUAS',
  monto: 250,
};
const OM_SUELTO: Fila = {
  ...gastoBase,
  id: 'g-om-suelto',
  categoria: 'OTROS_MOVIMIENTOS',
  monto: 400,
  fecha_gasto: '2026-09-05',
  notas: 'Reposición de extra pagado a tercero',
};
const OM_AVION: Fila = {
  ...gastoBase,
  id: 'g-om-avion',
  aeronave_id: AV,
  categoria: 'OTROS_MOVIMIENTOS',
  monto: 600,
  fecha_gasto: '2026-09-06',
  notas: 'Pernocta tripulación',
};

function tablas(gastos: Fila[]): Record<string, Fila[]> {
  return {
    aeronave: [
      { id: AV, matricula: 'XB-TST', modelo: 'C206', color_calendario: null },
    ],
    cliente: [],
    vuelo: [
      {
        id: V1,
        folio: 501,
        cliente_id: null,
        aeronave_id: AV,
        estado: 'COMPLETADO',
        es_externo: false,
        fecha_vuelo: `${DIA}T15:00:00+00:00`,
        tiempo_cobrable_hr: 2,
        tarifa_hora_usd: 1000,
        iva_usd: 0,
        iva_pct: 0,
        monto_total_usd: 2000,
        monto_total_mxn: 40000,
        tc_usd_mxn: 20,
        cobrado: false,
        calculo_snapshot: null,
        subtotal_vuelo_usd: 2000,
        ajuste_final_usd: 0,
        comision_vendedor_usd: 0,
        comision_vendedor_nombre: null,
        tuas_usd: 0,
        extras_total_usd: 0,
        viaticos_pernocta_usd: 0,
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
    gasto: gastos,
    gasto_reparto: [],
  };
}

type Privado = {
  buildPayload: (desde: string, hasta: string) => Promise<DineroXlsxPayload>;
};

function armar(gastos: Fila[]) {
  const service = new DineroReportService(
    fakeSupabase(tablas(gastos)),
    {} as never,
  );
  return (service as unknown as Privado).buildPayload(DESDE, HASTA);
}

const egresos = (p: DineroXlsxPayload) =>
  p.otros_ingresos.map((f) => f.concepto_egreso ?? '').join(' | ');

describe('Libro Dinero — OTROS_MOVIMIENTOS CON vuelo: fila de SOLO-egreso en «Otros ingresos» (espejo del TUA pagado)', () => {
  it('una fila por gasto con el concepto de la oficina; ingreso null; utilidades IDÉNTICAS; nada en «otros gastos»', async () => {
    const base = await armar([]);
    const p = await armar([OM_VUELO]);
    expect(p.otros_ingresos).toHaveLength(1);
    expect(p.otros_ingresos[0]).toMatchObject({
      clave: '#501',
      concepto_egreso: CONCEPTO_OM_VUELO,
      egreso_mxn: 1250,
      fecha_egreso: '2026-09-12',
      concepto_ingreso: null,
      ingreso_mxn: null,
      remanente_mxn: -1250,
    });
    expect(p.otros_gastos).toHaveLength(0);
    expect(p.utilidades_otros_ingresos_mxn).toBe(
      base.utilidades_otros_ingresos_mxn,
    );
    expect(p.utilidades_otros_gastos_mxn).toBe(0);
    expect(p.utilidades_aviones ?? []).toHaveLength(0);
  });

  it('USD × tc_gasto; sin tc_gasto × el T.C. de venta del vuelo (la regla de lo PAGADO en el vuelo)', async () => {
    const conTc = await armar([
      { ...OM_VUELO, moneda: 'USD', monto: 100, tc_gasto: 18.5 },
    ]);
    expect(conTc.otros_ingresos[0].egreso_mxn).toBe(1850);
    const sinTc = await armar([
      { ...OM_VUELO, moneda: 'USD', monto: 100, tc_gasto: null },
    ]);
    expect(sinTc.otros_ingresos[0].egreso_mxn).toBe(2000);
  });

  it('con la TUA pagada y dos egresos: la TUA primero (sin línea cobrada) y los egresos en orden (fecha, id)', async () => {
    const p = await armar([TUAS_VUELO, OM_VUELO, OM_VUELO_2]);
    expect(p.otros_ingresos.map((f) => f.concepto_egreso)).toEqual([
      'tuas pagadas (sin línea TUAS cobrada)',
      'Propina handling · CUN',
      CONCEPTO_OM_VUELO,
    ]);
    expect(p.otros_ingresos.reduce((a, f) => a + (f.egreso_mxn ?? 0), 0)).toBe(
      1800,
    );
    expect(p.utilidades_otros_ingresos_mxn).toBe(0);
    expect(egresos(p)).not.toContain('USD sin TC');
  });
});

describe('Libro Dinero — OTROS_MOVIMIENTOS SIN vuelo: se LISTA en «otros gastos» sin sumar ni acreditar (como «tuas sin vuelo»)', () => {
  it('sin avión: fila con el sufijo, acumulado intacto, utilidades sin cambio', async () => {
    const p = await armar([
      OM_SUELTO,
      { ...gastoBase, id: 'g-otro-suelto', categoria: 'OTRO', monto: 150 },
    ]);
    expect(p.otros_gastos).toHaveLength(2);
    // Orden por fecha_gasto: el OM (5-sep) antes del OTRO (10-sep).
    expect(p.otros_gastos[0]).toMatchObject({
      fecha: '2026-09-05',
      concepto:
        'Otros movimientos (VuelaTour) · Reposición de extra pagado a tercero · (egreso VuelaTour — no resta: Otros movimientos)',
      monto_mxn: 400,
      acumulado_mxn: 0,
    });
    expect(p.otros_gastos[1]).toMatchObject({
      monto_mxn: 150,
      acumulado_mxn: 150,
    });
    expect(p.utilidades_otros_gastos_mxn).toBe(150);
    expect(p.otros_ingresos).toHaveLength(0);
  });

  it('con avión sellado: tampoco se acredita al avión en utilidades (el avión solo informa)', async () => {
    const p = await armar([OM_AVION]);
    expect(p.otros_gastos).toHaveLength(1);
    expect(p.otros_gastos[0].concepto).toContain(
      '(egreso VuelaTour — no resta: Otros movimientos)',
    );
    expect(p.otros_gastos[0].acumulado_mxn).toBe(0);
    expect(p.utilidades_otros_gastos_mxn).toBe(0);
    expect(p.utilidades_aviones ?? []).toHaveLength(0);
  });
});
