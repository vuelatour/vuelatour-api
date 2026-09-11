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
 * REGLA DEL CLIENTE (11-sep-2026) — **la categoría de EMPRESA manda sobre el
 * vuelo**: OTRO, NOMINA, GASOLINA, FIJO y VISITA van SIEMPRE a la hoja
 * "otros gastos" del Balance general VuelaTour aunque el gasto traiga vuelo
 * o avión (el vuelo queda como referencia "· vuelo #folio"), y NO restan en
 * la fila del vuelo, ni en las hojas del libro del avión, ni en su cascada.
 * FBO con vuelo sigue en la columna OTROS de la fila (regla 27-jul viva) y
 * el reparto manual sigue GANANDO (parciales a los aviones + remanente a la
 * empresa).
 *
 * Y la columna PAGO (conciliación con bancos): cada fila de hoja ledger
 * viaja con la forma de pago legible.
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

/** Gasto ligado al vuelo #501 (el embebido `vuelo` lo usa la hoja de empresa). */
const conVuelo = { vuelo_id: 'v-1', vuelo: { folio: 501 } };

const GASTOS: Fila[] = [
  // Controles: siguen restando en la fila del vuelo.
  {
    ...gastoBase,
    ...conVuelo,
    id: 'g-op',
    categoria: 'OPERACIONES',
    monto: 300,
  },
  { ...gastoBase, ...conVuelo, id: 'g-fbo', categoria: 'FBO', monto: 500 },
  // Regla nueva: categoría de EMPRESA con vuelo / con avión.
  {
    ...gastoBase,
    ...conVuelo,
    id: 'g-otro-vuelo',
    categoria: 'OTRO',
    monto: 1000,
    notas: 'Comisariato del vuelo',
    medio_pago: 'TARJETA_CORP',
    tarjeta_terminacion: '4321',
  },
  {
    ...gastoBase,
    ...conVuelo,
    id: 'g-otro-repartido',
    categoria: 'OTRO',
    monto: 900,
  },
  {
    ...gastoBase,
    id: 'g-nomina-avion',
    aeronave_id: AV,
    categoria: 'NOMINA',
    monto: 2000,
  },
  // Controles de las hojas del avión y de los sueltos de siempre.
  {
    ...gastoBase,
    id: 'g-indirecto-avion',
    aeronave_id: AV,
    categoria: 'INDIRECTO',
    monto: 400,
  },
  { ...gastoBase, id: 'g-otro-suelto', categoria: 'OTRO', monto: 150 },
  { ...gastoBase, id: 'g-tuas-suelto', categoria: 'TUAS', monto: 80 },
];

function tablas(
  gastos: Fila[] = GASTOS,
  /** Overrides del vuelo y del tramo (horas voladas vs cobradas). */
  ov: { vuelo?: Fila; escala?: Fila } = {},
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
        ...(ov.escala ?? {}),
      },
    ],
    cobro_vuelo: [],
    gasto: gastos,
    gasto_reparto: [
      {
        gasto_id: 'g-otro-repartido',
        aeronave_id: AV,
        monto: 600,
        gasto: GASTOS.find((g) => g.id === 'g-otro-repartido'),
      },
    ],
    aeronave_socio: [],
    aeropuerto: [],
    cliente: [],
    usuario: [],
  };
}

function armar(gastos?: Fila[], ov: { vuelo?: Fila; escala?: Fila } = {}) {
  const supabase = fakeSupabase(tablas(gastos, ov));
  const nada = {} as never;
  const aircraft = { proximoServicio: () => null } as never;
  const tipoCambio = {
    oficialDetallePara: () => Promise.resolve(null),
  } as never;
  const service = new AircraftBalanceService(
    supabase,
    nada,
    aircraft,
    tipoCambio,
    nada,
  );
  return service;
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
  ) => Promise<{ empresa: unknown[]; tuasSueltos: unknown[] }>;
  buildHoja: (
    gastos: unknown[],
    tcPromedio: number | null,
    horas: number,
    hoja: string,
    pendientes: string[],
  ) => { filas: BalanceAvionGastoFilaPayload[]; total_mxn: number };
};

const priv = (s: AircraftBalanceService) => s as unknown as Privado;

describe('Balance por avión — la categoría de EMPRESA manda sobre el vuelo (11-sep-2026)', () => {
  it('OTRO con vuelo y NOMINA con avión NO restan en la fila ni en las hojas del avión', async () => {
    const payload = await priv(armar()).buildPayload(AV, DESDE, HASTA);
    const fila = payload.vuelos.find((v) => String(v.folio) === '501');
    expect(fila).toBeDefined();
    // Columnas de la fila: solo el control de OPERACIONES y el FBO.
    expect(fila!.op_mxn).toBe(300);
    expect(fila!.otros_mxn).toBe(500); // FBO sigue en OTROS (regla 27-jul)
    expect(fila!.piloto_mxn).toBeNull();
    // Ni el OTRO del vuelo ni su remanente asoman en las notas de celda.
    const notas = [
      ...(fila!.op_detalle ?? []),
      ...(fila!.piloto_detalle ?? []),
      ...(fila!.otros_detalle ?? []),
    ].join(' | ');
    expect(notas).not.toContain('Comisariato');
    // Hojas del avión: NOMINA sellada al avión ya no es indirecto suyo.
    const detalles = (f: BalanceAvionGastoFilaPayload[]) =>
      f.map((x) => x.detalle).join(' | ');
    expect(payload.gastos_indirectos.total_mxn).toBe(400);
    expect(detalles(payload.gastos_indirectos.filas)).toContain('INDIRECTO');
    expect(detalles(payload.gastos_indirectos.filas)).not.toContain('NOMINA');
    // Cascada: solo el indirecto de 400 (y el parcial repartido, abajo).
    expect(payload.balance.gastos_indirectos_usd).toBe(20); // 400 / TC 20
  });

  it('el reparto manual SIGUE ganando: el parcial vive en la hoja del avión', async () => {
    const payload = await priv(armar()).buildPayload(AV, DESDE, HASTA);
    expect(payload.otros_gastos.total_mxn).toBe(600);
    expect(payload.otros_gastos.filas).toHaveLength(1);
    expect(payload.otros_gastos.filas[0].detalle).toContain('reparto manual');
    expect(payload.balance.otros_usd).toBe(30); // 600 / TC 20
  });

  it('la hoja "otros gastos" del general reúne los de EMPRESA con o sin vuelo, sin duplicar', async () => {
    const { empresa, tuasSueltos } = await priv(armar()).gastosEmpresaYSueltos(
      DESDE,
      HASTA,
    );
    const porId = new Map(
      (empresa as Array<Record<string, unknown>>).map((g) => [
        g.id as string,
        g,
      ]),
    );
    // Un gasto por id: el suelto de empresa cae en las DOS consultas.
    expect(empresa).toHaveLength(porId.size);
    expect([...porId.keys()].sort()).toEqual([
      'g-nomina-avion',
      'g-otro-repartido',
      'g-otro-suelto',
      'g-otro-vuelo',
    ]);
    // El OTRO del vuelo entra COMPLETO y con la referencia al folio.
    expect(porId.get('g-otro-vuelo')!.monto).toBe(1000);
    expect(porId.get('g-otro-vuelo')!.referencia_detalle).toBe('vuelo #501');
    // El repartido entra SOLO por su remanente (900 − 600).
    expect(porId.get('g-otro-repartido')!.monto).toBe(300);
    expect(String(porId.get('g-otro-repartido')!.notas)).toContain(
      'remanente de reparto',
    );
    // TUAS sueltos intactos (regla 7): no restan en ninguna hoja.
    expect(tuasSueltos).toHaveLength(1);
  });

  it('el detalle de la hoja cita el vuelo como referencia y pinta la forma de PAGO', async () => {
    const service = armar();
    const { empresa } = await priv(service).gastosEmpresaYSueltos(DESDE, HASTA);
    const hoja = priv(service).buildHoja(empresa, 20, 0, 'otros gastos', []);
    const fila = hoja.filas.find((f) =>
      (f.detalle ?? '').includes('Comisariato'),
    );
    expect(fila).toBeDefined();
    expect(fila!.detalle).toBe('Comisariato del vuelo · vuelo #501');
    // Columna PAGO (conciliación con bancos): medio + terminación.
    expect(fila!.pago).toBe('Tarjeta corporativa ****4321');
    // 1000 + 2000 + 150 + 300 de remanente.
    expect(hoja.total_mxn).toBe(3450);
  });

  it('columna PAGO en la hoja del avión: medio conocido y celda vacía sin medio', () => {
    const hoja = priv(armar()).buildHoja(
      [
        { ...gastoBase, categoria: 'GAS', monto: 100, medio_pago: 'EFECTIVO' },
        { ...gastoBase, categoria: 'GAS', monto: 50, medio_pago: null },
      ],
      20,
      0,
      'combustible',
      [],
    );
    expect(hoja.filas.map((f) => f.pago)).toEqual(['Efectivo', null]);
  });
});

/**
 * El dinero entra UNA vez: un gasto de categoría de EMPRESA con vuelo viaja
 * ENTERO a la hoja "otros gastos" del general, así que su parte TUA embebida
 * (desglose IA de una factura de aeródromo) NO puede salir además como
 * egreso "tuas pagadas" en la pestaña "Otros movimientos" — sería restar dos
 * veces en el MISMO libro.
 */
describe('Balance general — TUA embebido de un gasto de EMPRESA (11-sep-2026)', () => {
  type PrivadoOM = {
    buildOtrosMovimientos: (
      desde: string,
      hasta: string,
      memoTc: Map<string, unknown>,
      empresaYSueltos: { empresa: unknown[]; tuasSueltos: unknown[] },
    ) => Promise<{
      filas: Array<{
        concepto_egreso: string | null;
        egreso_mxn: number | null;
      }>;
    }>;
  };
  const om = (s: AircraftBalanceService) => s as unknown as PrivadoOM;
  /** Factura de aeródromo con TUA embebido (tabla resumen: suma == total). */
  const conceptosTua = {
    conceptos: [
      { concepto: 'Tarifa TUA', monto: 600 },
      { concepto: 'Operaciones', monto: 400 },
    ],
  };

  it('un OTRO con vuelo NO genera egreso de "tuas pagadas" (ya restó entero en "otros gastos")', async () => {
    const service = armar([
      {
        ...gastoBase,
        ...conVuelo,
        id: 'g-otro-con-tua',
        categoria: 'OTRO',
        monto: 1000,
        valor_ia_extraido: conceptosTua,
      },
    ]);
    const hoja = await om(service).buildOtrosMovimientos(
      DESDE,
      HASTA,
      new Map(),
      {
        empresa: [],
        tuasSueltos: [],
      },
    );
    expect(
      hoja.filas.map((f) => f.concepto_egreso ?? '').join(' | '),
    ).not.toMatch(/tua/i);
    expect(hoja.filas.reduce((a, f) => a + (f.egreso_mxn ?? 0), 0)).toBe(0);
  });

  it('control: la MISMA factura como OPERACIONES sí aparea su TUA pagado', async () => {
    const service = armar([
      {
        ...gastoBase,
        ...conVuelo,
        id: 'g-op-con-tua',
        categoria: 'OPERACIONES',
        monto: 1000,
        valor_ia_extraido: conceptosTua,
      },
    ]);
    const hoja = await om(service).buildOtrosMovimientos(
      DESDE,
      HASTA,
      new Map(),
      {
        empresa: [],
        tuasSueltos: [],
      },
    );
    const tua = hoja.filas.find((f) =>
      /tuas pagadas/i.test(f.concepto_egreso ?? ''),
    );
    expect(tua).toBeDefined();
    expect(tua!.egreso_mxn).toBe(600);
  });
});

/**
 * NOTA «voló más de lo que se cobró» (regla del cliente, 11-sep-2026).
 * Antes era un pendiente que exigía «recotizar con las horas reales» en
 * cuanto la diferencia pasaba de 0.01 hr. El cliente aclaró que cobrar horas
 * CERRADAS es lo normal (se cobran 4.0 y se vuelan 4.3): el aviso salía en
 * casi todos los vuelos y tapaba los pendientes que sí hay que atender.
 * Ahora es una NOTA informativa y solo por encima de MEDIA HORA.
 */
describe('Pendientes de captura — horas voladas vs cobradas (11-sep-2026)', () => {
  /** Vuelo de 2.00 hr cobradas; el tramo vuela `horas` (taco 100 → 100+h). */
  const notasDeVuelo = async (horas: number) => {
    const payload = await priv(
      armar(GASTOS, { escala: { taco_llegada: 100 + horas } }),
    ).buildPayload(AV, DESDE, HASTA);
    // Solo la nota del vuelo (hay otros pendientes con la palabra "voló",
    // como el del combustible del periodo).
    return payload.pendientes.filter((p) => /se cobraron/.test(p));
  };

  it('diferencia de 0.10 hr (horas cerradas): NO se anota nada', async () => {
    expect(await notasDeVuelo(2.1)).toEqual([]);
  });

  it('media hora exacta tampoco (el umbral es ESTRICTAMENTE mayor a 0.5)', async () => {
    expect(await notasDeVuelo(2.5)).toEqual([]);
  });

  it('más de media hora: NOTA informativa con la diferencia, sin pedir recotizar', async () => {
    const [nota] = await notasDeVuelo(2.6);
    expect(nota).toBeDefined();
    expect(nota).toContain('voló 2.60 hr y se cobraron 2.00');
    expect(nota).toContain('(diferencia 0.60 hr)');
    expect(nota).toContain('solo informativo');
    // El texto viejo mandaba a recotizar: eso ya no es lo que el cliente
    // quiere (cobrar horas cerradas es normal).
    expect(nota).not.toMatch(/recotizar/i);
  });
});
