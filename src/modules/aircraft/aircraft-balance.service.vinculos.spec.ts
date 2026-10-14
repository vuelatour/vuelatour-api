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
import type {
  BalanceAvionGastoFilaPayload,
  BalanceAvionPayload,
} from '../pyservices/pyservices.service';

/**
 * VÍNCULOS GASTO → CELDA DEL BALANCE (13-oct-2026, API 0.0.75, invariante
 * 72): cada rama de la fila del vuelo que empuja una línea de detalle nacida
 * de un gasto empuja su vínculo con el MISMO monto (TUA y traslados como
 * 'nota', USD sin T.C. como 'sin_tc'; el costo del operador externo sin
 * vínculo); cada fila de las hojas ledger lleva `gasto_id` (+ `gasto_parte`
 * en un parcial o remanente del reparto). Metadatos: ningún número cambia.
 * Arnés copiado de aircraft-balance.service.empresa.spec.ts.
 */
type Fila = Record<string, unknown>;

/** Valor de una columna, con soporte de rutas embebidas ("gasto.vuelo_id"). */
function valorEn(fila: Fila, col: string): unknown {
  return col.split('.').reduce<unknown>((acc, k) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    const v = (acc as Record<string, unknown>)[k];
    return Array.isArray(v) ? (v[0] as unknown) : v;
  }, fila);
}

/** Comparación de PostgREST: fechas ISO por instante, lo demás crudo. */
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

/** Mini-PostgREST en memoria: filtra las filas que el servicio pide. */
function fakeSupabase(tablas: Record<string, Fila[]>): SupabaseService {
  const from = (tabla: string) => {
    let filas = [...(tablas[tabla] ?? [])];
    const filtrar = (fn: (f: Fila) => boolean) => {
      filas = filas.filter(fn);
      return q;
    };
    const q: Record<string, unknown> = {
      select: () => q,
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
      order: (c: string, opts?: { ascending?: boolean }) => {
        const dir = opts?.ascending === false ? -1 : 1;
        filas.sort((a, b) => dir * cmp(valorEn(a, c), valorEn(b, c)));
        return q;
      },
      limit: (n: number) => {
        filas = filas.slice(0, n);
        return q;
      },
      // Paginación de PostgREST (max-rows = 1000): `range` es inclusivo en
      // ambos extremos.
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

const AV = 'av-1';
const DESDE = '2026-09-01';
const HASTA = '2026-09-30';
const DIA = '2026-09-10';

const gastoBase = {
  escala_id: null,
  aeronave_id: null,
  vuelo_id: null,
  propina: null,
  moneda: 'MXN',
  tc_gasto: null,
  litros: null,
  fecha_gasto: DIA,
  notas: null,
  lugar: null,
  medio_pago: 'TRANSFERENCIA',
  tarjeta_terminacion: null,
  inventario_movimiento_id: null,
  valor_ia_extraido: null,
  proveedor: null,
};

const enVuelo = { vuelo_id: 'v-1', vuelo: { folio: 501 } };

/** Factura ASUR repartida por la IA: Op 67.14 + TUA 50.00 + FBO 87.00. */
const MIXTA: Fila = {
  ...gastoBase,
  ...enVuelo,
  id: 'g-mixta',
  categoria: 'OPERACIONES',
  monto: 204.14,
  valor_ia_extraido: {
    conceptos: [
      { concepto: 'Aterrizaje', monto: 67.14 },
      { concepto: 'TUA', monto: 50 },
      { concepto: 'Servicio FBO', monto: 87 },
    ],
  },
};

const GASTOS_FILA: Fila[] = [
  {
    ...gastoBase,
    ...enVuelo,
    id: 'g-op',
    categoria: 'OPERACIONES',
    monto: 300,
  },
  { ...gastoBase, ...enVuelo, id: 'g-comida', categoria: 'COMIDA', monto: 206 },
  { ...gastoBase, ...enVuelo, id: 'g-fbo', categoria: 'FBO', monto: 500 },
  MIXTA,
  { ...gastoBase, ...enVuelo, id: 'g-tuas', categoria: 'TUAS', monto: 80 },
  // Fuera de la fila: empresa con vuelo, PERMISO y GAS con vuelo.
  { ...gastoBase, ...enVuelo, id: 'g-otro', categoria: 'OTRO', monto: 1000 },
  {
    ...gastoBase,
    ...enVuelo,
    id: 'g-permiso',
    aeronave_id: AV,
    categoria: 'PERMISO',
    monto: 2549,
  },
  {
    ...gastoBase,
    ...enVuelo,
    id: 'g-gas',
    aeronave_id: AV,
    categoria: 'GAS',
    monto: 8939.38,
    litros: 300,
    escala: null,
  },
];

function tablas(
  gastos: Fila[],
  ov: { vuelo?: Fila; repartos?: Fila[] } = {},
): Record<string, Fila[]> {
  const vuelo: Fila = {
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
    tuas_usd: 0,
    extras_total_usd: 0,
    viaticos_pernocta_usd: 0,
    monto_total_usd: 2000,
    monto_total_mxn: 40000,
    tc_usd_mxn: 20,
    comision_vendedor_usd: 0,
    cobrado: false,
    calculo_snapshot: null,
    ...(ov.vuelo ?? {}),
  };
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
    vuelo: [vuelo],
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
    gasto_reparto: ov.repartos ?? [],
    aeronave_socio: [],
    aeropuerto: [],
    cliente: [],
    usuario: [],
  };
}

function armar(gastos: Fila[], ov: { vuelo?: Fila; repartos?: Fila[] } = {}) {
  const supabase = fakeSupabase(tablas(gastos, ov));
  const nada = {} as never;
  const aircraft = { proximoServicio: () => null } as never;
  const tipoCambio = {
    oficialDetallePara: () => Promise.resolve(null),
  } as never;
  return new AircraftBalanceService(supabase, nada, aircraft, tipoCambio, nada);
}

type Privado = {
  buildPayload: (
    aircraftId: string | null,
    desde: string,
    hasta: string,
  ) => Promise<BalanceAvionPayload>;
  gastosEmpresaYSueltos: (
    desde: string,
    hasta: string,
  ) => Promise<{ empresa: Fila[]; tuasSueltos: Fila[] }>;
  buildHoja: (
    gastos: unknown[],
    tcPromedio: number | null,
    horas: number,
    hoja: string,
    pendientes: string[],
    opciones?: { tcPorFila?: boolean },
  ) => {
    filas: BalanceAvionGastoFilaPayload[];
    total_mxn: number;
    usd: number | null;
  };
};
const priv = (s: AircraftBalanceService) => s as unknown as Privado;

type Vinculo = {
  id: string;
  rol: string;
  monto_mxn: number | null;
  gasto_mxn?: number | null;
};
const sumaDe = (l: Vinculo[] | undefined) =>
  Math.round(
    (l ?? [])
      .filter((v) => v.rol === 'suma')
      .reduce((a, v) => a + (v.monto_mxn ?? 0), 0) * 100,
  ) / 100;

async function filaDe(gastos: Fila[], ov: { vuelo?: Fila } = {}) {
  const payload = await priv(armar(gastos, ov)).buildPayload(AV, DESDE, HASTA);
  const fila = payload.vuelos.find((v) => String(v.folio) === '501');
  expect(fila).toBeDefined();
  return { payload, fila: fila as unknown as Record<string, unknown> };
}

describe('Balance — vínculos gasto → celda en la fila del vuelo (invariante 72)', () => {
  it('(a) OPERACIONES, COMIDA, FBO, factura repartida op+FBO+TUA y TUAS: cada celda lista sus gastos con el MISMO monto', async () => {
    const { fila } = await filaDe(GASTOS_FILA);
    expect(fila.op_vinculos).toEqual([
      { id: 'g-op', rol: 'suma', monto_mxn: 300 },
      { id: 'g-mixta', rol: 'suma', monto_mxn: 67.14, gasto_mxn: 204.14 },
      { id: 'g-tuas', rol: 'nota', monto_mxn: null, gasto_mxn: 80 },
    ]);
    expect(fila.otros_vinculos).toEqual([
      { id: 'g-fbo', rol: 'suma', monto_mxn: 500 },
      { id: 'g-mixta', rol: 'suma', monto_mxn: 87, gasto_mxn: 204.14 },
    ]);
    expect(fila.piloto_vinculos).toEqual([
      { id: 'g-comida', rol: 'suma', monto_mxn: 206 },
    ]);
    // Σ de lo que SUMA cada lista == la celda (±0.01).
    for (const [lista, celda] of [
      ['op_vinculos', 'op_mxn'],
      ['otros_vinculos', 'otros_mxn'],
      ['piloto_vinculos', 'piloto_mxn'],
    ] as const) {
      expect(
        Math.abs(sumaDe(fila[lista] as Vinculo[]) - Number(fila[celda] ?? 0)),
      ).toBeLessThanOrEqual(0.01);
    }
  });

  it('(b) OTRO, PERMISO y GAS con vuelo no van en ninguna lista; PERMISO y GAS sí llevan gasto_id en sus hojas', async () => {
    const { payload, fila } = await filaDe(GASTOS_FILA);
    const ids = [
      ...(fila.op_vinculos as Vinculo[]),
      ...(fila.piloto_vinculos as Vinculo[]),
      ...(fila.otros_vinculos as Vinculo[]),
    ].map((v) => v.id);
    for (const id of ['g-otro', 'g-permiso', 'g-gas']) {
      expect(ids).not.toContain(id);
    }
    expect(payload.permisos.filas.map((f) => f.gasto_id)).toEqual([
      'g-permiso',
    ]);
    expect((payload.combustible?.filas ?? []).map((f) => f.gasto_id)).toEqual([
      'g-gas',
    ]);
  });

  it('(c) USD sin ningún T.C. ⇒ «sin_tc» en la columna de su categoría', async () => {
    const { fila } = await filaDe(
      [
        {
          ...gastoBase,
          ...enVuelo,
          id: 'g-op',
          categoria: 'OPERACIONES',
          monto: 300,
        },
        {
          ...gastoBase,
          ...enVuelo,
          id: 'g-hotel-usd',
          categoria: 'HOTEL',
          moneda: 'USD',
          monto: 120,
        },
      ],
      { vuelo: { tc_usd_mxn: null, monto_total_mxn: null } },
    );
    expect(fila.piloto_vinculos).toEqual([
      { id: 'g-hotel-usd', rol: 'sin_tc', monto_mxn: null },
    ]);
    expect(fila.op_vinculos).toEqual([
      { id: 'g-op', rol: 'suma', monto_mxn: 300 },
    ]);
  });

  it('(d) EXTERNO con costo del operador: la nota lo trae, los vínculos no, y Σ == OPERACIONES − el costo', async () => {
    const { fila } = await filaDe(
      [
        {
          ...gastoBase,
          ...enVuelo,
          id: 'g-op',
          categoria: 'OPERACIONES',
          monto: 300,
        },
      ],
      {
        vuelo: {
          es_externo: true,
          operador_externo: 'XA-TYV',
          costo_externo_usd: 100,
        },
      },
    );
    expect(
      (fila.op_detalle as string[]).some((l) =>
        l.startsWith('Costo operador externo (XA-TYV)'),
      ),
    ).toBe(true);
    expect(fila.op_vinculos).toEqual([
      { id: 'g-op', rol: 'suma', monto_mxn: 300 },
    ]);
    // Costo del operador = 100 USD × K 20 = 2,000 MXN.
    expect(Number(fila.op_mxn)).toBeCloseTo(2300, 2);
    expect(sumaDe(fila.op_vinculos as Vinculo[])).toBe(
      Number(fila.op_mxn) - 2000,
    );
  });

  it('(f) orden de llaves: las listas justo después de otros_detalle y antes de permiso_afac_mxn', async () => {
    const { fila } = await filaDe(GASTOS_FILA);
    const llaves = Object.keys(fila);
    expect(llaves.indexOf('op_vinculos')).toBe(
      llaves.indexOf('otros_detalle') + 1,
    );
    expect(
      llaves.slice(
        llaves.indexOf('op_vinculos'),
        llaves.indexOf('op_vinculos') + 3,
      ),
    ).toEqual(['op_vinculos', 'piloto_vinculos', 'otros_vinculos']);
    expect(llaves.indexOf('otros_vinculos')).toBeLessThan(
      llaves.indexOf('permiso_afac_mxn'),
    );
  });

  it('(g) cada gasto aparece UNA vez entre listas y filas del payload, salvo la misma factura en op + FBO', async () => {
    const { payload } = await filaDe(GASTOS_FILA);
    const vistos: string[] = [];
    for (const v of payload.vuelos) {
      const f = v as unknown as Record<string, Vinculo[] | undefined>;
      const enFila = [
        ...(f.op_vinculos ?? []),
        ...(f.piloto_vinculos ?? []),
        ...(f.otros_vinculos ?? []),
      ].map((x) => x.id);
      vistos.push(...new Set(enFila));
    }
    for (const hoja of [
      payload.gastos_indirectos,
      payload.otros_gastos,
      payload.permisos,
      payload.combustible,
      payload.refacciones,
    ]) {
      for (const f of hoja?.filas ?? []) {
        if (f.gasto_id) vistos.push(f.gasto_id);
      }
    }
    const repetidos = vistos.filter((id, i) => vistos.indexOf(id) !== i);
    expect(repetidos).toEqual([]);
    // La mixta va en op Y en FBO (dos celdas de la MISMA fila).
    const fila = payload.vuelos[0] as unknown as Record<string, Vinculo[]>;
    expect(fila.op_vinculos.some((v) => v.id === 'g-mixta')).toBe(true);
    expect(fila.otros_vinculos.some((v) => v.id === 'g-mixta')).toBe(true);
  });
});

describe('Balance — gasto_id y gasto_parte en las hojas ledger (invariante 72)', () => {
  it('(e) buildHoja: cada fila termina en gasto_id (con tcPorFila: …, tc_aplicado, gasto_id)', () => {
    const svc = priv(armar([]));
    const pend: string[] = [];
    const hoja = svc.buildHoja(
      [{ ...gastoBase, id: 'g-1', categoria: 'PERMISO', monto: 100 }],
      20,
      0,
      'permisos',
      pend,
      { tcPorFila: true },
    );
    expect(Object.keys(hoja.filas[0]).slice(-2)).toEqual([
      'tc_aplicado',
      'gasto_id',
    ]);
    expect(hoja.filas[0].gasto_id).toBe('g-1');
    expect(hoja.filas[0]).not.toHaveProperty('gasto_parte');
    const sin = svc.buildHoja(
      [{ ...gastoBase, categoria: 'INDIRECTO', monto: 100 }],
      20,
      0,
      'Gastos Indirectos',
      pend,
    );
    expect(Object.keys(sin.filas[0]).slice(-1)).toEqual(['gasto_id']);
    expect(sin.filas[0].gasto_id).toBeNull();
  });

  it('(e) un parcial del reparto lleva el id del PADRE y gasto_parte «reparto»; el remanente, «remanente»', async () => {
    const padre: Fila = {
      ...gastoBase,
      id: 'g-cramex',
      categoria: 'INDIRECTO',
      monto: 1000,
      notas: 'gestoria cramex sep',
    };
    const svc = armar([padre], {
      repartos: [
        { gasto_id: 'g-cramex', aeronave_id: AV, monto: 400, gasto: padre },
      ],
    });
    const payload = await priv(svc).buildPayload(AV, DESDE, HASTA);
    const parcial = payload.gastos_indirectos.filas.find(
      (f) => f.gasto_id === 'g-cramex',
    );
    expect(parcial).toMatchObject({
      gasto_id: 'g-cramex',
      gasto_parte: 'reparto',
    });
    const { empresa } = await priv(svc).gastosEmpresaYSueltos(DESDE, HASTA);
    expect(empresa).toHaveLength(1);
    expect(empresa[0]).toMatchObject({
      id: 'g-cramex',
      monto: 600,
      es_remanente_reparto: true,
    });
    const hojaEmpresa = priv(svc).buildHoja(empresa, 20, 0, 'otros gastos', []);
    expect(hojaEmpresa.filas[0]).toMatchObject({
      gasto_id: 'g-cramex',
      gasto_parte: 'remanente',
    });
  });
});
