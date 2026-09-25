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
import { DineroReportService } from '../profit-sharing/dinero-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceHojaOtrosMovimientosPayload,
  DineroXlsxPayload,
} from '../pyservices/pyservices.service';

/**
 * BALANCE GENERAL «Otros movimientos» + INGRESOS SIN VUELO (24-sep-2026,
 * contrato de ingresos §7.7 y §12.9).
 *
 * 1. Sin ingresos la pestaña sale BYTE-IDÉNTICA a la de antes del cambio
 *    (GOLDEN capturado con el código sin modificar; sin la migración ni
 *    siquiera se consulta la tabla).
 * 2. Con ingresos: una fila por ingreso de RESULTADO al final de las
 *    sueltas, con las MISMAS cifras que el Libro Dinero (fuente única
 *    `filaLibroDeIngreso`), y el TOTAL remanente sube lo mismo que
 *    `utilidades_otros_ingresos_mxn`.
 */
// ===== Mundo compartido de los libros (se pega TAL CUAL en los dos specs) =====
type Fila = Record<string, unknown>;

const AV = 'av-1';
const V1 = 'v-1';
const DESDE = '2026-09-01';
const HASTA = '2026-09-30';
const DIA = '2026-09-10';

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

/**
 * Mini-PostgREST en memoria. `sinMigracion` = la columna
 * `movimiento_bancario.ingreso_id` NO existe (42703 en la sonda) y la tabla
 * `ingreso` tampoco. `tablasLeidas` registra qué tablas se consultaron.
 */
function fakeSupabase(
  tablas: Record<string, Fila[]>,
  opts: { sinMigracion?: boolean } = {},
) {
  const tablasLeidas: string[] = [];
  const from = (tabla: string) => {
    tablasLeidas.push(tabla);
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
        if (
          opts.sinMigracion &&
          (tabla === 'ingreso' ||
            (typeof cols === 'string' && /\bingreso_id\b/.test(cols)))
        ) {
          error = {
            code: '42703',
            message: 'column movimiento_bancario.ingreso_id does not exist',
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
  return { supabase: { service: { from } }, tablasLeidas };
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
  tarjeta_terminacion: null,
  inventario_movimiento_id: null,
  proveedor: null,
  vuelo: null,
};

/**
 * Un mes con de todo: vuelo con TUAS, extras y comisión del vendedor,
 * cobros (uno con comisión bancaria), TUA pagado, combustible, gastos de
 * empresa y sueltos. Suficiente para recorrer las ramas de «Otros ingresos»
 * del Libro Dinero y de «Otros movimientos» del Balance general.
 */
function mundoLibros(ingresos: Fila[] = []): Record<string, Fila[]> {
  const vuelo: Fila = {
    id: V1,
    folio: 501,
    cliente_id: 'cli-1',
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
    tuas_usd: 100,
    extras_total_usd: 50,
    viaticos_pernocta_usd: 0,
    comision_vendedor_usd: 80,
    comision_vendedor_nombre: 'Vendedor Uno',
    monto_total_usd: 2230,
    monto_total_mxn: 44600,
    tc_usd_mxn: 20,
    cobrado: false,
    calculo_snapshot: null,
    cliente: { nombre: 'Leticia León Alvarado' },
  };
  return {
    aeronave: [
      {
        id: AV,
        matricula: 'XB-TST',
        modelo: 'C206',
        color_calendario: '#3B82F6',
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      },
    ],
    cliente: [{ id: 'cli-1', nombre: 'Leticia León Alvarado' }],
    vuelo: [vuelo],
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
        fecha_salida_plan: `${DIA}T15:00:00+00:00`,
        vuelo: { fecha_vuelo: `${DIA}T15:00:00+00:00`, aeronave_id: AV },
      },
    ],
    cobro_vuelo: [
      {
        id: 'c-1',
        vuelo_id: V1,
        monto: 20000,
        moneda: 'MXN',
        tc_usd_mxn: 20,
        fecha_cobro: `${DIA}T16:00:00+00:00`,
        comision_banco_monto: 350,
      },
      {
        id: 'c-2',
        vuelo_id: V1,
        monto: 1000,
        moneda: 'USD',
        tc_usd_mxn: 20,
        fecha_cobro: '2026-09-12T16:00:00+00:00',
        comision_banco_monto: null,
      },
    ],
    factura: [],
    gasto: [
      {
        ...gastoBase,
        id: 'g-tuas',
        vuelo_id: V1,
        vuelo: { folio: 501, aeronave_id: AV },
        categoria: 'TUAS',
        monto: 1500,
      },
      {
        ...gastoBase,
        id: 'g-gas',
        aeronave_id: AV,
        categoria: 'GAS',
        monto: 3000,
        litros: 100,
      },
      {
        ...gastoBase,
        id: 'g-otro',
        categoria: 'OTRO',
        monto: 700,
        notas: 'Papelería',
      },
      {
        ...gastoBase,
        id: 'g-tuas-suelto',
        categoria: 'TUAS',
        monto: 80,
      },
      {
        ...gastoBase,
        id: 'g-gas-sin-avion',
        categoria: 'GAS',
        monto: 250,
      },
    ],
    gasto_reparto: [],
    aeronave_socio: [],
    aeropuerto: [],
    usuario: [],
    movimiento_bancario: [],
    ingreso: ingresos,
  };
}

/** Los cuatro ingresos del contrato §12.9 (2 de resultado + 2 fuera). */
const INGRESOS_LIBROS: Fila[] = [
  {
    id: 'i-1',
    folio: 12,
    categoria: 'OTRO_INGRESO',
    fecha: '2026-09-15',
    descripcion: 'Renta de hangar a tercero',
    monto: 5000,
    comision_monto: 50,
    moneda: 'MXN',
    tc_usd_mxn: null,
    pagador: 'Aeroclub Cancún',
    deleted_at: null,
    cliente: null,
    vuelo: null,
    aeronave: null,
  },
  {
    id: 'i-2',
    folio: 13,
    categoria: 'INGRESO_BANCARIO',
    fecha: '2026-09-20',
    descripcion: 'Intereses cuenta USD',
    monto: 100,
    comision_monto: null,
    moneda: 'USD',
    tc_usd_mxn: 18.5,
    pagador: null,
    deleted_at: null,
    cliente: null,
    vuelo: null,
    aeronave: null,
  },
  {
    id: 'i-3',
    folio: 14,
    categoria: 'ANTICIPO_CLIENTE',
    fecha: '2026-09-21',
    descripcion: 'Anticipo vuelo de octubre',
    monto: 30000,
    comision_monto: null,
    moneda: 'MXN',
    tc_usd_mxn: null,
    pagador: null,
    deleted_at: null,
    cliente: { nombre: 'Leticia León Alvarado' },
    vuelo: null,
    aeronave: null,
  },
  {
    id: 'i-4',
    folio: 15,
    categoria: 'APORTACION_PRESTAMO',
    fecha: '2026-09-22',
    descripcion: 'Aportación de socio',
    monto: 200000,
    comision_monto: null,
    moneda: 'MXN',
    tc_usd_mxn: null,
    pagador: 'Socio A',
    deleted_at: null,
    cliente: null,
    vuelo: null,
    aeronave: null,
  },
];
// ===== fin del mundo compartido =====

/** «Otros movimientos» ANTES del cambio (código sin modificar). */
const GOLDEN_OM = {
  filas: [
    {
      clave: 'vtleticia501',
      avion_color: '#3B82F6',
      estado: 'COMPLETADO',
      fecha_vuelo: '2026-09-10',
      factura: null,
      concepto_ingreso:
        'comisión vendedor + TUAs con IVA · 2 conceptos (ver nota)',
      ingreso_mxn: 4600,
      fecha_ingreso: '2026-09-10',
      nota_ingreso:
        'comisión vendedor (Vendedor Uno) = $1,600.00\ntuas/extras/pernocta cobrados + iva (sin desglose canónico: estimado con columnas) = $3,000.00',
      concepto_egreso:
        'pago comisión vendedor + TUAs + comisión bancaria · 3 conceptos (ver nota)',
      egreso_mxn: 3450,
      fecha_egreso: '2026-09-10',
      nota_egreso:
        'pago comisión vendedor (Vendedor Uno) · PROVISIÓN (mismo monto que lo cobrado: comisión + IVA; sin gasto real capturado) = $1,600.00\ntuas pagadas = $1,500.00\ncomisión bancaria = $350.00',
      remanente_mxn: 1150,
    },
  ],
  filas_sueltas: [
    {
      clave: 'tuas sin vuelo',
      avion_color: null,
      fecha_vuelo: null,
      concepto_egreso: 'TUAS',
      egreso_mxn: 80,
      fecha_egreso: '2026-09-10',
      concepto_ingreso: null,
      ingreso_mxn: null,
      fecha_ingreso: null,
      remanente_mxn: -80,
      factura: null,
    },
    {
      clave: 'gas sin avión',
      avion_color: null,
      fecha_vuelo: null,
      concepto_egreso: 'Gasavión / Turbosina',
      egreso_mxn: 250,
      fecha_egreso: '2026-09-10',
      concepto_ingreso: null,
      ingreso_mxn: null,
      fecha_ingreso: null,
      remanente_mxn: -250,
      factura: null,
    },
  ],
} as unknown as BalanceHojaOtrosMovimientosPayload;

type PrivadoOM = {
  gastosEmpresaYSueltos: (desde: string, hasta: string) => Promise<unknown>;
  buildOtrosMovimientos: (
    desde: string,
    hasta: string,
    memoTc: Map<string, unknown>,
    empresaYSueltos: unknown,
  ) => Promise<BalanceHojaOtrosMovimientosPayload>;
};

async function otrosMovimientos(
  ingresos: Fila[] = [],
  opts: { sinMigracion?: boolean } = {},
) {
  const f = fakeSupabase(mundoLibros(ingresos), opts);
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    {} as never,
  );
  const priv = service as unknown as PrivadoOM;
  const om = await priv.buildOtrosMovimientos(
    DESDE,
    HASTA,
    new Map(),
    await priv.gastosEmpresaYSueltos(DESDE, HASTA),
  );
  return { om, tablas: f.tablasLeidas };
}

const remanente = (filas: Array<{ remanente_mxn: number | null }>) =>
  Math.round(filas.reduce((a, f) => a + (f.remanente_mxn ?? 0), 0) * 100) / 100;

describe('Balance general «Otros movimientos» — ingresos sin vuelo (24-sep-2026)', () => {
  it('SIN la migración: payload byte-idéntico al de hoy y ni una consulta a `ingreso`', async () => {
    const { om, tablas } = await otrosMovimientos([], { sinMigracion: true });
    expect(JSON.stringify(om)).toBe(JSON.stringify(GOLDEN_OM));
    expect(tablas).not.toContain('ingreso');
  });

  it('CON la migración y SIN ingresos: payload byte-idéntico al de hoy', async () => {
    const { om } = await otrosMovimientos([]);
    expect(JSON.stringify(om)).toBe(JSON.stringify(GOLDEN_OM));
  });

  it('4 ingresos (2 de resultado) ⇒ solo 2 filas nuevas AL FINAL de las sueltas', async () => {
    const { om } = await otrosMovimientos(INGRESOS_LIBROS);
    expect(om.filas).toEqual(GOLDEN_OM.filas);
    const n = GOLDEN_OM.filas_sueltas.length;
    expect(om.filas_sueltas.slice(0, n)).toEqual(GOLDEN_OM.filas_sueltas);
    expect(om.filas_sueltas.slice(n)).toEqual([
      {
        clave: 'ING-12',
        avion_color: null,
        fecha_vuelo: null,
        concepto_egreso: 'comisión bancaria',
        egreso_mxn: 50,
        fecha_egreso: '2026-09-15',
        concepto_ingreso:
          'Otros ingresos · Renta de hangar a tercero · Aeroclub Cancún',
        ingreso_mxn: 5000,
        fecha_ingreso: '2026-09-15',
        remanente_mxn: 4950,
        factura: null,
      },
      {
        clave: 'ING-13',
        avion_color: null,
        fecha_vuelo: null,
        concepto_egreso: null,
        egreso_mxn: null,
        fecha_egreso: null,
        concepto_ingreso: 'Ingresos en cuentas de banco · Intereses cuenta USD',
        ingreso_mxn: 1850,
        fecha_ingreso: '2026-09-20',
        remanente_mxn: 1850,
        factura: null,
      },
    ]);
  });

  it('los DOS libros dicen el MISMO número (filas y total remanente = utilidades)', async () => {
    const { om } = await otrosMovimientos(INGRESOS_LIBROS);
    const f = fakeSupabase(mundoLibros(INGRESOS_LIBROS));
    const dinero = await (
      new DineroReportService(
        f.supabase as unknown as SupabaseService,
        {} as never,
      ) as unknown as {
        buildPayload: (a: string, b: string) => Promise<DineroXlsxPayload>;
      }
    ).buildPayload(DESDE, HASTA);
    const ingBalance = om.filas_sueltas.filter((x) =>
      x.clave.startsWith('ING-'),
    );
    const ingDinero = dinero.otros_ingresos.filter((x) =>
      x.clave.startsWith('ING-'),
    );
    expect(
      ingBalance.map((x) => [
        x.clave,
        x.ingreso_mxn,
        x.egreso_mxn,
        x.remanente_mxn,
      ]),
    ).toEqual(
      ingDinero.map((x) => [
        x.clave,
        x.ingreso_mxn,
        x.egreso_mxn,
        x.remanente_mxn,
      ]),
    );
    // TOTAL remanente del Balance general sube EXACTAMENTE lo mismo que las
    // utilidades del Libro Dinero (la comisión se resta en los dos).
    const { om: omSin } = await otrosMovimientos([]);
    const deltaBalance =
      remanente([...om.filas, ...om.filas_sueltas]) -
      remanente([...omSin.filas, ...omSin.filas_sueltas]);
    const f0 = fakeSupabase(mundoLibros([]));
    const dineroSin = await (
      new DineroReportService(
        f0.supabase as unknown as SupabaseService,
        {} as never,
      ) as unknown as {
        buildPayload: (a: string, b: string) => Promise<DineroXlsxPayload>;
      }
    ).buildPayload(DESDE, HASTA);
    const deltaUtilidades =
      (dinero.utilidades_otros_ingresos_mxn ?? 0) -
      (dineroSin.utilidades_otros_ingresos_mxn ?? 0);
    expect(Math.round(deltaBalance * 100) / 100).toBe(6800);
    expect(Math.round(deltaUtilidades * 100) / 100).toBe(6800);
  });
});
