// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { BalanceAvionPayload } from '../pyservices/pyservices.service';

/**
 * TUA SISTÉMICA en el Balance (13-oct-2026, invariante 66). La fila del
 * vuelo y «Otros movimientos» separan la MISMA TUA por la fuente única
 * (`partesDeGasto` / `trasladosPagadosDeGasto`): la de la OFICINA
 * (`gasto.tua_incluida`) manda sobre la lectura y la nota lo dice; sin
 * columna ni señal, el payload es el de siempre. La sonda de
 * `gasto.tua_incluida` responde 42703 con `sinMigracion`.
 */
type Fila = Record<string, unknown>;

function valorEn(fila: Fila, col: string): unknown {
  return col.split('.').reduce<unknown>((acc, k) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    const v = (acc as Record<string, unknown>)[k];
    return Array.isArray(v) ? (v[0] as unknown) : v;
  }, fila);
}

function cmp(a: unknown, b: unknown): number {
  const iso = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  if (iso(a) || iso(b)) {
    const na = Date.parse(String(a));
    const nb = Date.parse(String(b));
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const sa = a == null ? '' : typeof a === 'string' ? a : JSON.stringify(a);
  const sb = b == null ? '' : typeof b === 'string' ? b : JSON.stringify(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** Mini-PostgREST en memoria que además REGISTRA los selects de cada tabla. */
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

const AV = 'av-1';
const DESDE = '2026-10-01';
const HASTA = '2026-10-31';
const DIA = '2026-10-06';

const gastoBase = {
  escala_id: null,
  aeronave_id: AV,
  vuelo_id: 'v-1',
  vuelo: { folio: 501 },
  propina: '0.00',
  moneda: 'MXN',
  tc_gasto: null,
  litros: null,
  fecha_gasto: DIA,
  notas: 'ASUR CUN',
  lugar: null,
  medio_pago: 'TARJETA_CORP',
  tarjeta_terminacion: '0585',
  inventario_movimiento_id: null,
  valor_ia_extraido: null,
  proveedor: null,
};

/** #383 tal como lo leyó la IA: la TUA quedó como «Autobuses». */
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

function gastoAsur(extra: Fila = {}): Fila {
  return {
    ...gastoBase,
    id: 'g-asur',
    categoria: 'OPERACIONES',
    monto: '1925.27',
    valor_ia_extraido: LECTURA_383,
    ...extra,
  };
}

function tablas(gastos: Fila[]): Record<string, Fila[]> {
  return {
    aeronave: [
      {
        id: AV,
        matricula: 'XB-TST',
        modelo: 'C206',
        color_calendario: null,
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      },
    ],
    vuelo: [
      {
        id: 'v-1',
        folio: 501,
        cliente_id: null,
        aeronave_id: AV,
        estado: 'COMPLETADO',
        tipo: 'CHARTER',
        es_externo: false,
        operador_externo: null,
        costo_externo_usd: null,
        fecha_vuelo: `${DIA}T15:00:00+00:00`,
        fecha_solicitud: null,
        fecha_traslado_final: null,
        origen_iata: 'CUN',
        destino_iata: 'MID',
        tiempo_cobrable_hr: 2,
        tarifa_hora_usd: 1000,
        iva_pct: 0,
        iva_usd: 0,
        subtotal_vuelo_usd: 2000,
        ajuste_final_usd: 0,
        // TUA cobrada al cliente: la línea «tuas» de otros movimientos.
        tuas_usd: 30,
        extras_total_usd: 0,
        viaticos_pernocta_usd: 0,
        monto_total_usd: 2030,
        monto_total_mxn: 40600,
        tc_usd_mxn: 20,
        comision_vendedor_usd: 0,
        cobrado: false,
        calculo_snapshot: null,
      },
    ],
    escala: [
      {
        id: 'e-1',
        vuelo_id: 'v-1',
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'MID',
        taco_salida: 100,
        taco_llegada: 102,
        aeronave_id: null,
        cancelada_at: null,
        solo_operativa: false,
        es_ferry: false,
        fecha_salida_plan: `${DIA}T15:00:00+00:00`,
        taco_salida_obs: null,
        taco_llegada_obs: null,
        taco_obs_updated_by: null,
        taco_obs_updated_at: null,
        vuelo: { fecha_vuelo: `${DIA}T15:00:00+00:00`, aeronave_id: AV },
      },
    ],
    cobro_vuelo: [],
    gasto: gastos,
    gasto_reparto: [],
    aeronave_socio: [],
    aeropuerto: [],
    cliente: [],
    usuario: [],
  };
}

function armar(gastos: Fila[], opts: { sinMigracion?: boolean } = {}) {
  const f = fakeSupabase(tablas(gastos), opts);
  const nada = {} as never;
  const aircraft = { proximoServicio: () => null } as never;
  const tipoCambio = {
    oficialDetallePara: () => Promise.resolve(null),
  } as never;
  const service = new AircraftBalanceService(
    f.supabase,
    nada,
    aircraft,
    tipoCambio,
    nada,
  );
  return { service, selects: f.selects };
}

type Privado = {
  buildPayload: (
    aircraftId: string | null,
    desde: string,
    hasta: string,
  ) => Promise<BalanceAvionPayload>;
  buildOtrosMovimientos: (
    desde: string,
    hasta: string,
    memoTc: Map<string, unknown>,
    empresaYSueltos: { empresa: unknown[]; tuasSueltos: unknown[] },
  ) => Promise<{
    filas: Array<{
      concepto_ingreso: string | null;
      concepto_egreso: string | null;
      egreso_mxn: number | null;
    }>;
  }>;
};

const priv = (s: AircraftBalanceService) => s as unknown as Privado;

async function filaDel501(
  gastos: Fila[],
  opts: { sinMigracion?: boolean } = {},
) {
  const p = await priv(armar(gastos, opts).service).buildPayload(
    AV,
    DESDE,
    HASTA,
  );
  const fila = p.vuelos.find((v) => String(v.folio) === '501');
  expect(fila).toBeDefined();
  return fila!;
}

async function egresoTuas(gastos: Fila[]) {
  const hoja = await priv(armar(gastos).service).buildOtrosMovimientos(
    DESDE,
    HASTA,
    new Map(),
    { empresa: [], tuasSueltos: [] },
  );
  const filas = hoja.filas.filter((f) =>
    /tuas pagadas/i.test(f.concepto_egreso ?? ''),
  );
  return filas.reduce((a, f) => a + (f.egreso_mxn ?? 0), 0);
}

describe('Balance — TUA sistémica (13-oct-2026, invariante 66)', () => {
  it('#383 + tua_monto de la IA: OPERACIONES 1,365.64 y la MISMA TUA (559.63) en la fila y en «tuas pagadas»', async () => {
    const g = gastoAsur({
      valor_ia_extraido: { ...LECTURA_383, tua_monto: 559.63 },
    });
    const fila = await filaDel501([g]);
    expect(fila.op_mxn).toBe(1365.64);
    expect(fila.tua_pagado_mxn).toBe(559.63);
    expect((fila.op_detalle ?? []).join(' | ')).toContain(
      'TUA (IVA incluido) $559.63**',
    );
    expect((fila.op_detalle ?? []).join(' | ')).not.toContain('fijada');
    expect(await egresoTuas([g])).toBe(559.63);
  });

  it('control: #383 SIN señal ni override ⇒ todo a OPERACIONES y sin «tuas pagadas» (lo de hoy)', async () => {
    const fila = await filaDel501([gastoAsur()]);
    expect(fila.op_mxn).toBe(1925.27);
    expect(fila.tua_pagado_mxn).toBeNull();
    expect(await egresoTuas([gastoAsur()])).toBe(0);
  });

  it('oficina fija 0 sobre un renglón «Tarifa TUA»: OPERACIONES entera, sin TUA** y con «TUA: 0 (fijada por oficina)»', async () => {
    const g = gastoAsur({
      valor_ia_extraido: LECTURA_TARIFA_TUA,
      tua_incluida: '0.00',
    });
    const fila = await filaDel501([g]);
    expect(fila.op_mxn).toBe(1925.27);
    expect(fila.tua_pagado_mxn).toBeNull();
    const nota = (fila.op_detalle ?? []).join(' | ');
    expect(nota).not.toContain('**');
    expect(nota).toContain('$1,925.27 · TUA: 0 (fijada por oficina)');
    expect(await egresoTuas([g])).toBe(0);
  });

  it('oficina fija 700 ⇒ nota «TUA (IVA incluido) $700.00** (fijada por oficina)» y egreso 700', async () => {
    const g = gastoAsur({ tua_incluida: '700.00' });
    const fila = await filaDel501([g]);
    expect(fila.op_mxn).toBe(1225.27);
    expect(fila.tua_pagado_mxn).toBe(700);
    expect((fila.op_detalle ?? []).join(' | ')).toContain(
      'TUA (IVA incluido) $700.00** (fijada por oficina)',
    );
    expect(await egresoTuas([g])).toBe(700);
  });

  it('OTRO con vuelo + 700 ⇒ fuera de la fila (empresa) y 0 en «tuas pagadas»', async () => {
    const g = gastoAsur({ categoria: 'OTRO', tua_incluida: '700.00' });
    const fila = await filaDel501([g]);
    expect(fila.op_mxn).toBeNull();
    expect(fila.tua_pagado_mxn).toBeNull();
    expect(await egresoTuas([g])).toBe(0);
  });

  it('USD 100 con T.C. 18.5 y TUA de oficina 10 ⇒ 185 MXN en la fila y en «tuas pagadas»', async () => {
    const g = gastoAsur({
      monto: '100.00',
      moneda: 'USD',
      tc_gasto: '18.5',
      valor_ia_extraido: null,
      tua_incluida: '10.00',
    });
    const fila = await filaDel501([g]);
    expect(fila.tua_pagado_mxn).toBe(185);
    expect(fila.op_mxn).toBe(1665);
    expect(await egresoTuas([g])).toBe(185);
  });

  it('GOLDEN: sin columna ni señal el libro y la pestaña son idénticos con y sin la migración; sin ella NINGUNA consulta nombra tua_incluida', async () => {
    const gastos = [
      gastoAsur({ valor_ia_extraido: LECTURA_TARIFA_TUA }),
      { ...gastoBase, id: 'g-fbo', categoria: 'FBO', monto: 500 },
    ];
    const con = armar(gastos);
    const sin = armar(gastos, { sinMigracion: true });
    const [libroCon, libroSin] = await Promise.all([
      priv(con.service).buildPayload(AV, DESDE, HASTA),
      priv(sin.service).buildPayload(AV, DESDE, HASTA),
    ]);
    expect(JSON.stringify(libroSin)).toBe(JSON.stringify(libroCon));
    const [omCon, omSin] = await Promise.all([
      priv(con.service).buildOtrosMovimientos(DESDE, HASTA, new Map(), {
        empresa: [],
        tuasSueltos: [],
      }),
      priv(sin.service).buildOtrosMovimientos(DESDE, HASTA, new Map(), {
        empresa: [],
        tuasSueltos: [],
      }),
    ]);
    expect(JSON.stringify(omSin)).toBe(JSON.stringify(omCon));
    // Con la migración, SOLO las dos lecturas de gastos de vuelos la nombran.
    expect(
      con.selects.filter(
        (s) => s.cols !== 'tua_incluida' && /tua_incluida/.test(s.cols),
      ),
    ).toHaveLength(2);
    expect(
      sin.selects.filter(
        (s) => s.cols !== 'tua_incluida' && /tua_incluida/.test(s.cols),
      ),
    ).toHaveLength(0);
  });
});
