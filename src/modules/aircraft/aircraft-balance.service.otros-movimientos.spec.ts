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
  BalanceAvionPayload,
  BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';

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
 * «OTROS MOVIMIENTOS (VUELATOUR)» como gasto (23-oct-2026, API 0.0.106,
 * invariante 107; pedido del cliente: «Falta la opción de agregar un gasto a
 * la hoja de "otros movimientos" en el balance general»).
 *
 * Con vuelo: UNA línea de SOLO-egreso en el bloque de su vuelo de la hoja
 * «otros movimientos» (concepto de la oficina, fecha del gasto, pesos como
 * las «tuas pagadas»), colapsada con las demás líneas del vuelo. Sin vuelo:
 * fila SUELTA «otros movimientos sin vuelo» (con la matrícula delante si
 * trae avión sellado). La hoja maestra y las hojas del avión NO cambian: el
 * avión solo informa.
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
const COLOR = '#112233';
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

/** Gasto ligado al vuelo #501 del avión AV. */
const conVuelo = { vuelo_id: 'v-1', vuelo: { folio: 501 } };

/** Controles de la fila del vuelo (siguen igual que siempre). */
const CONTROLES: Fila[] = [
  {
    ...gastoBase,
    ...conVuelo,
    id: 'g-op',
    categoria: 'OPERACIONES',
    monto: 300,
  },
  { ...gastoBase, ...conVuelo, id: 'g-fbo', categoria: 'FBO', monto: 500 },
];

/** Viáticos de pernocta que VuelaTour pagó al piloto (el caso del cliente). */
const OM_VUELO: Fila = {
  ...gastoBase,
  ...conVuelo,
  id: 'g-om-1',
  categoria: 'OTROS_MOVIMIENTOS',
  monto: 1250,
  fecha_gasto: '2026-09-12',
  notas: 'Viáticos de pernocta pagados al piloto\n⚠ aviso de la IA',
  medio_pago: 'EFECTIVO_EMPRESA',
  proveedor: { nombre: 'Hotel Xcaret' },
};
const CONCEPTO_OM_VUELO =
  'Viáticos de pernocta pagados al piloto · Hotel Xcaret (efectivo de la empresa)';

/** Un extra pagado a un tercero, sin proveedor: el lugar como referencia. */
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

/** Sin vuelo ni avión: fila suelta (viene de la lectura de «otros gastos»). */
const OM_SUELTO: Fila = {
  ...gastoBase,
  id: 'g-om-suelto',
  categoria: 'OTROS_MOVIMIENTOS',
  monto: 400,
  fecha_gasto: '2026-09-05',
  notas: 'Reposición de extra pagado a tercero',
};

/** Sin vuelo CON avión sellado: el avión solo informa (lectura propia). */
const OM_AVION: Fila = {
  ...gastoBase,
  id: 'g-om-avion',
  aeronave_id: AV,
  categoria: 'OTROS_MOVIMIENTOS',
  monto: 600,
  fecha_gasto: '2026-09-06',
  notas: 'Pernocta tripulación',
};

function tablas(
  gastos: Fila[],
  ov: { vuelo?: Fila } = {},
): Record<string, Fila[]> {
  return {
    aeronave: [
      {
        id: AV,
        matricula: 'XB-TST',
        modelo: 'C206',
        color_calendario: COLOR,
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

function armar(gastos: Fila[], ov: { vuelo?: Fila } = {}) {
  const supabase = fakeSupabase(tablas(gastos, ov));
  const nada = {} as never;
  const aircraft = { proximoServicio: () => null } as never;
  const tipoCambio = {
    oficialDetallePara: () => Promise.resolve(null),
  } as never;
  return new AircraftBalanceService(supabase, nada, aircraft, tipoCambio, nada);
}

type TcFilas = {
  filas: Array<number | null>;
  sueltas: Array<number | null>;
  porCobrarVtUsd: number[];
};
type EmpresaYSueltos = {
  empresa: Fila[];
  tuasSueltos: Fila[];
  pagosAfac?: Fila[];
  otrosMovimientosSueltos?: Fila[];
};
type HojaOM = {
  filas: BalanceOtroMovimientoFilaPayload[];
  filas_sueltas: BalanceOtroMovimientoFilaPayload[];
};
type Privado = {
  buildPayload: (
    aircraftId: string | null,
    desde: string,
    hasta: string,
  ) => Promise<BalanceAvionPayload>;
  gastosEmpresaYSueltos: (
    desde: string,
    hasta: string,
  ) => Promise<{
    empresa: Fila[];
    tuasSueltos: Fila[];
    otrosMovimientosSueltos: Fila[];
  }>;
  buildOtrosMovimientos: (
    desde: string,
    hasta: string,
    memoTc: Map<string, unknown>,
    empresaYSueltos: EmpresaYSueltos,
    memoFactura?: Map<string, unknown>,
    tcFilas?: TcFilas,
  ) => Promise<HojaOM>;
};
const priv = (s: AircraftBalanceService) => s as unknown as Privado;

const VACIO: EmpresaYSueltos = { empresa: [], tuasSueltos: [] };

/** La hoja «otros movimientos» con los gastos dados (sin sueltas). */
const hojaDe = (gastos: Fila[], ov: { vuelo?: Fila } = {}) =>
  priv(armar(gastos, ov)).buildOtrosMovimientos(DESDE, HASTA, new Map(), VACIO);

describe('gastosEmpresaYSueltos — el OTROS_MOVIMIENTOS suelto NO va a «otros gastos»', () => {
  it('sin vuelo ni avión ⇒ `otrosMovimientosSueltos`; OTRO y TUAS sueltos siguen en su lista; con avión no entra a esta lectura', async () => {
    const r = await priv(
      armar([
        OM_SUELTO,
        OM_AVION,
        { ...gastoBase, id: 'g-otro-suelto', categoria: 'OTRO', monto: 150 },
        { ...gastoBase, id: 'g-tuas-suelto', categoria: 'TUAS', monto: 80 },
      ]),
    ).gastosEmpresaYSueltos(DESDE, HASTA);
    expect(r.otrosMovimientosSueltos.map((g) => g.id)).toEqual(['g-om-suelto']);
    expect(r.empresa.map((g) => g.id)).toEqual(['g-otro-suelto']);
    expect(r.tuasSueltos.map((g) => g.id)).toEqual(['g-tuas-suelto']);
  });
});

describe('Balance general «otros movimientos» — gasto OTROS_MOVIMIENTOS CON vuelo', () => {
  it('UNA línea de SOLO-egreso en el bloque del vuelo: concepto de la oficina, fecha del gasto, pesos tal cual; remanente = −egreso', async () => {
    const hoja = await hojaDe([...CONTROLES, OM_VUELO]);
    expect(hoja.filas).toHaveLength(1);
    expect(hoja.filas[0]).toMatchObject({
      clave: '#501',
      estado: 'COMPLETADO',
      concepto_ingreso: null,
      ingreso_mxn: null,
      concepto_egreso: CONCEPTO_OM_VUELO,
      egreso_mxn: 1250,
      fecha_egreso: '2026-09-12',
      remanente_mxn: -1250,
    });
    expect(hoja.filas_sueltas).toHaveLength(0);
  });

  it('USD con tc_gasto ⇒ × su T.C.; USD sin tc_gasto ⇒ × el T.C. promedio de la pestaña (la regla de las «tuas pagadas»)', async () => {
    const conTc = await hojaDe([
      {
        ...OM_VUELO,
        moneda: 'USD',
        monto: 100,
        tc_gasto: 18.5,
        medio_pago: 'TRANSFERENCIA',
        proveedor: null,
      },
    ]);
    expect(conTc.filas[0]).toMatchObject({
      concepto_egreso: 'Viáticos de pernocta pagados al piloto',
      egreso_mxn: 1850,
      remanente_mxn: -1850,
    });
    const sinTc = await hojaDe([
      { ...OM_VUELO, moneda: 'USD', monto: 100, tc_gasto: null },
    ]);
    // K del vuelo = 20 ⇒ T.C. promedio 20.
    expect(sinTc.filas[0].egreso_mxn).toBe(2000);
    expect(sinTc.filas[0].concepto_egreso).not.toContain('USD sin TC');
  });

  it('con la TUA pagada y dos egresos: UNA fila colapsada, Σ egresos, la nota lista cada concepto en orden (TUA, luego fecha/id)', async () => {
    const hoja = await hojaDe([...CONTROLES, TUAS_VUELO, OM_VUELO, OM_VUELO_2]);
    expect(hoja.filas).toHaveLength(1);
    const f = hoja.filas[0];
    expect(f.egreso_mxn).toBe(1800);
    expect(f.remanente_mxn).toBe(-1800);
    expect(f.concepto_egreso).toContain('3 conceptos (ver nota)');
    const nota = f.nota_egreso ?? '';
    expect(nota).toContain('tuas pagadas = $250.00');
    expect(nota).toContain('Propina handling · CUN = $300.00');
    expect(nota).toContain(`${CONCEPTO_OM_VUELO} = $1,250.00`);
    expect(nota.indexOf('tuas pagadas')).toBeLessThan(
      nota.indexOf('Propina handling'),
    );
    expect(nota.indexOf('Propina handling')).toBeLessThan(
      nota.indexOf('Viáticos de pernocta'),
    );
    // La fecha del egreso de la fila es la MÁS ANTIGUA de sus líneas.
    expect(f.fecha_egreso).toBe(DIA);
  });

  it('un vuelo CANCELADO también lo lista (es un egreso real) y la fila va marcada', async () => {
    const hoja = await hojaDe([OM_VUELO], { vuelo: { estado: 'CANCELADO' } });
    expect(hoja.filas).toHaveLength(1);
    expect(hoja.filas[0]).toMatchObject({
      estado: 'CANCELADO',
      egreso_mxn: 1250,
      ingreso_mxn: null,
    });
  });

  it('sin gastos de la categoría la hoja es la de siempre (sin filas ni sueltas nuevas)', async () => {
    const hoja = await hojaDe(CONTROLES);
    expect(hoja.filas).toHaveLength(0);
    expect(hoja.filas_sueltas).toHaveLength(0);
  });
});

describe('Balance general «otros movimientos» — gasto OTROS_MOVIMIENTOS SIN vuelo (filas sueltas)', () => {
  it('sin avión (de la lectura compartida) y con avión sellado (lectura propia, matrícula delante): clave «otros movimientos sin vuelo», T.C. alineado', async () => {
    const tcFilas: TcFilas = { filas: [], sueltas: [], porCobrarVtUsd: [] };
    const hoja = await priv(
      armar([...CONTROLES, OM_AVION]),
    ).buildOtrosMovimientos(
      DESDE,
      HASTA,
      new Map(),
      { ...VACIO, otrosMovimientosSueltos: [OM_SUELTO] },
      new Map(),
      tcFilas,
    );
    expect(hoja.filas).toHaveLength(0);
    expect(hoja.filas_sueltas).toHaveLength(2);
    expect(hoja.filas_sueltas[0]).toMatchObject({
      clave: 'otros movimientos sin vuelo',
      avion_color: null,
      fecha_vuelo: null,
      concepto_egreso: 'Reposición de extra pagado a tercero',
      egreso_mxn: 400,
      fecha_egreso: '2026-09-05',
      concepto_ingreso: null,
      ingreso_mxn: null,
      remanente_mxn: -400,
      factura: null,
    });
    expect(hoja.filas_sueltas[1]).toMatchObject({
      clave: 'otros movimientos sin vuelo',
      avion_color: COLOR,
      concepto_egreso: 'XB-TST · Pernocta tripulación',
      egreso_mxn: 600,
      fecha_egreso: '2026-09-06',
      remanente_mxn: -600,
    });
    // Bloque VUELATOUR: un T.C. por suelta (jamás desalineado).
    expect(tcFilas.sueltas).toHaveLength(2);
    expect(tcFilas.filas).toHaveLength(hoja.filas.length);
    // Las sueltas no llevan los datos del vuelo (invariante 106).
    for (const s of hoja.filas_sueltas) {
      expect(s).not.toHaveProperty('cliente');
      expect(s).not.toHaveProperty('ruta');
    }
  });
});

describe('Balance por avión — el OTROS_MOVIMIENTOS NO es costo del avión', () => {
  const payloadDe = (gastos: Fila[]) =>
    priv(armar(gastos)).buildPayload(AV, DESDE, HASTA);
  const filaDel501 = (p: BalanceAvionPayload) => {
    const fila = p.vuelos.find((v) => String(v.folio) === '501');
    expect(fila).toBeDefined();
    return fila!;
  };

  it('con vuelo: la fila del vuelo NO lo suma en ninguna columna ni lo cita; el remanente es IDÉNTICO a sin él', async () => {
    const sin = await payloadDe(CONTROLES);
    const con = await payloadDe([...CONTROLES, OM_VUELO, OM_VUELO_2]);
    const fSin = filaDel501(sin);
    const fCon = filaDel501(con);
    expect(fCon.op_mxn).toBe(300);
    expect(fCon.otros_mxn).toBe(500);
    expect(fCon.piloto_mxn).toBe(fSin.piloto_mxn);
    expect(fCon.remanente_mxn).toBe(fSin.remanente_mxn);
    const notas = [
      ...(fCon.op_detalle ?? []),
      ...(fCon.piloto_detalle ?? []),
      ...(fCon.otros_detalle ?? []),
    ].join(' | ');
    expect(notas).not.toContain('Viáticos');
    expect(notas).not.toContain('Propina');
  });

  it('con avión y SIN vuelo: no entra a «Gastos Indirectos» ni a ninguna hoja del avión (vive suelto en el general)', async () => {
    const p = await payloadDe([...CONTROLES, OM_AVION]);
    const detalles = [
      ...p.gastos_indirectos.filas,
      ...p.otros_gastos.filas,
      ...p.permisos.filas,
    ]
      .map((f) => f.detalle)
      .join(' | ');
    expect(detalles).not.toContain('Pernocta tripulación');
    expect(p.gastos_indirectos.total_mxn).toBe(0);
    expect(p.pendientes.join(' | ')).not.toContain('Pernocta tripulación');
  });
});
