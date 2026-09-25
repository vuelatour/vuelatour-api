// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { DineroReportService } from './dinero-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { DineroXlsxPayload } from '../pyservices/pyservices.service';

/**
 * LIBRO DINERO + INGRESOS SIN VUELO (24-sep-2026, contrato de ingresos §7.6
 * y §12.9).
 *
 * 1. Sin ingresos el payload es BYTE-IDÉNTICO al de antes del cambio: el
 *    GOLDEN de abajo se capturó con el código SIN modificar sobre este mismo
 *    mundo (y sin la migración ni siquiera se consulta la tabla).
 * 2. Con ingresos: SOLO las filas de RESULTADO (ING-n) se agregan AL FINAL
 *    de «Otros ingresos» y `utilidades_otros_ingresos_mxn` sube EXACTAMENTE
 *    Σ remanente de esas filas (ingreso − su comisión bancaria). Anticipos y
 *    aportaciones no aparecen.
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

/** Payload del Libro Dinero ANTES del cambio (código sin modificar). */
const GOLDEN_DINERO = {
  periodo_desde: '2026-09-01',
  periodo_hasta: '2026-09-30',
  generado: 'FIJO',
  leyenda_colores: [
    {
      matricula: 'XB-TST',
      modelo: 'C206',
      color: '#3B82F6',
    },
  ],
  vuelos: [
    {
      clave: 'vtleticia',
      matricula: 'XB-TST',
      color: '#3B82F6',
      fecha: '2026-09-10T15:00:00+00:00',
      ruta: 'cun-mid',
      tiempo: 2,
      venta_hr_usd: 1000,
      venta_hr_mxn: 20000,
      iva_hr_usd: 0,
      venta_hr_masiva_usd: 1000,
      total_cobrado_usd: 2000,
      iva_total_usd: 0,
      tc_venta: 20,
      total_cobrado_mxn: 40000,
      iva_total_mxn: 0,
      total_siva_mxn: 40000,
      total_cliente_usd: 2230,
      total_cliente_mxn: 44600,
      status_cobro: 'PENDIENTE',
      cobros: [
        {
          fecha: '2026-09-10T16:00:00+00:00',
          monto_mxn: 20000,
        },
        {
          fecha: '2026-09-12T16:00:00+00:00',
          monto_mxn: 20000,
        },
      ],
      total_cobros_mxn: 40000,
      me_deben_mxn: 4600,
      factura_vuelatour: null,
      participacion: 1,
      multi_avion: false,
    },
  ],
  otros_ingresos: [
    {
      clave: 'vtleticia',
      fecha_vuelo: '2026-09-10T15:00:00+00:00',
      concepto_egreso: 'tuas pagadas',
      egreso_mxn: 1500,
      fecha_egreso: '2026-09-10',
      nota_egreso: null,
      concepto_ingreso: 'tuas',
      ingreso_mxn: 2000,
      fecha_ingreso: '2026-09-10T15:00:00+00:00',
      remanente_mxn: 500,
      factura: null,
    },
    {
      clave: 'vtleticia',
      fecha_vuelo: '2026-09-10T15:00:00+00:00',
      concepto_egreso: null,
      egreso_mxn: null,
      fecha_egreso: null,
      nota_egreso: null,
      concepto_ingreso: 'extras',
      ingreso_mxn: 1000,
      fecha_ingreso: '2026-09-10T15:00:00+00:00',
      remanente_mxn: 1000,
      factura: null,
    },
    {
      clave: 'vtleticia',
      fecha_vuelo: '2026-09-10T15:00:00+00:00',
      concepto_egreso: 'pago comisión vendedor (Vendedor Uno) · provisión',
      egreso_mxn: 1600,
      fecha_egreso: '2026-09-10T15:00:00+00:00',
      nota_egreso:
        'PROVISIÓN: pago al vendedor por el mismo monto de la comisión cobrada (comisión + IVA = pagoVendedorUsd; neto de VuelaTour = precio base). No hay gasto capturado para este pago — hoy no existe categoría de gasto de comisión de venta. En la hoja utilidades ya está descontado de "otros ingresos".',
      concepto_ingreso: 'comisión vendedor (Vendedor Uno)',
      ingreso_mxn: 1600,
      fecha_ingreso: '2026-09-10T15:00:00+00:00',
      remanente_mxn: 0,
      factura: null,
    },
  ],
  otros_gastos: [
    {
      fecha: '2026-09-10',
      concepto: 'Otros gastos VuelaTour · Papelería',
      monto_mxn: 700,
      acumulado_mxn: 700,
    },
    {
      fecha: '2026-09-10',
      concepto: 'TUAS · (TUA pagado — no resta: Otros movimientos)',
      monto_mxn: 80,
      acumulado_mxn: 700,
    },
  ],
  combustible: [
    {
      fecha: '2026-09-10',
      matricula: 'XB-TST',
      avion_color: '#3B82F6',
      concepto: '',
      litros: 100,
      monto_mxn: 3000,
      acumulado_mxn: 3000,
    },
    {
      fecha: '2026-09-10',
      matricula: '—',
      avion_color: null,
      concepto: 'SIN AVIÓN — asignar aeronave en Combustibles',
      litros: null,
      monto_mxn: 250,
      acumulado_mxn: 3250,
    },
  ],
  combustible_total_mxn: 3250,
  combustible_litros: 100,
  combustible_precio_litro: 32.5,
  combustible_sin_avion: 1,
  utilidades_combustible_mxn: 3250,
  utilidades_otros_ingresos_mxn: 3000,
  utilidades_comision_vendedor_provisionada_mxn: 1600,
  utilidades_otros_gastos_mxn: 700,
  utilidades_tc: 20,
  utilidades_aviones: [
    {
      matricula: 'XB-TST',
      gastos_indirectos_mxn: null,
      otros_gastos_mxn: null,
      permisos_mxn: null,
      combustible_mxn: 3000,
    },
  ],
} as unknown as DineroXlsxPayload;

type Privado = {
  buildPayload: (desde: string, hasta: string) => Promise<DineroXlsxPayload>;
};

async function libroDinero(
  ingresos: Fila[] = [],
  opts: { sinMigracion?: boolean } = {},
) {
  const f = fakeSupabase(mundoLibros(ingresos), opts);
  const service = new DineroReportService(
    f.supabase as unknown as SupabaseService,
    {} as never,
  );
  const p = await (service as unknown as Privado).buildPayload(DESDE, HASTA);
  return { p: { ...p, generado: 'FIJO' }, tablas: f.tablasLeidas };
}

describe('Libro Dinero — ingresos sin vuelo (24-sep-2026)', () => {
  it('SIN la migración: payload byte-idéntico al de hoy y ni una consulta a `ingreso`', async () => {
    const { p, tablas } = await libroDinero([], { sinMigracion: true });
    expect(JSON.stringify(p)).toBe(JSON.stringify(GOLDEN_DINERO));
    expect(tablas).not.toContain('ingreso');
  });

  it('CON la migración y SIN ingresos: payload byte-idéntico al de hoy', async () => {
    const { p } = await libroDinero([]);
    expect(JSON.stringify(p)).toBe(JSON.stringify(GOLDEN_DINERO));
  });

  it('dados de baja o fuera del periodo: no cambian nada', async () => {
    const { p } = await libroDinero([
      { ...INGRESOS_LIBROS[0], deleted_at: '2026-09-16T10:00:00Z' },
      { ...INGRESOS_LIBROS[1], fecha: '2026-10-01' },
    ]);
    expect(JSON.stringify(p)).toBe(JSON.stringify(GOLDEN_DINERO));
  });

  it('OTRO MXN (comisión $50) + USD con TC + ANTICIPO + APORTACIÓN ⇒ solo 2 filas nuevas AL FINAL', async () => {
    const { p } = await libroDinero(INGRESOS_LIBROS);
    const n = GOLDEN_DINERO.otros_ingresos.length;
    expect(p.otros_ingresos).toHaveLength(n + 2);
    // Lo de antes, intacto y en el mismo orden.
    expect(p.otros_ingresos.slice(0, n)).toEqual(GOLDEN_DINERO.otros_ingresos);
    expect(p.otros_ingresos.slice(n)).toEqual([
      {
        clave: 'ING-12',
        fecha_vuelo: null,
        concepto_egreso: 'comisión bancaria',
        egreso_mxn: 50,
        fecha_egreso: '2026-09-15',
        nota_egreso: null,
        concepto_ingreso:
          'Otros ingresos · Renta de hangar a tercero · Aeroclub Cancún',
        ingreso_mxn: 5000,
        fecha_ingreso: '2026-09-15',
        remanente_mxn: 4950,
        factura: null,
      },
      {
        clave: 'ING-13',
        fecha_vuelo: null,
        concepto_egreso: null,
        egreso_mxn: null,
        fecha_egreso: null,
        nota_egreso: null,
        concepto_ingreso: 'Ingresos en cuentas de banco · Intereses cuenta USD',
        ingreso_mxn: 1850,
        fecha_ingreso: '2026-09-20',
        remanente_mxn: 1850,
        factura: null,
      },
    ]);
    // Utilidades sube EXACTAMENTE Σ remanente (5000 − 50 + 1850).
    expect(p.utilidades_otros_ingresos_mxn).toBe(
      Math.round(
        ((GOLDEN_DINERO.utilidades_otros_ingresos_mxn ?? 0) + 4950 + 1850) *
          100,
      ) / 100,
    );
    // Nada más cambia (ni vuelos, ni otros gastos, ni combustible, ni la
    // provisión del vendedor).
    const sinIngresos = {
      ...p,
      otros_ingresos: p.otros_ingresos.slice(0, n),
      utilidades_otros_ingresos_mxn:
        GOLDEN_DINERO.utilidades_otros_ingresos_mxn,
    };
    expect(JSON.stringify(sinIngresos)).toBe(JSON.stringify(GOLDEN_DINERO));
  });

  it('USD SIN TC (defensa: el CHECK lo impide): fila con la nota, sin sumar', async () => {
    const { p } = await libroDinero([
      { ...INGRESOS_LIBROS[1], tc_usd_mxn: null },
    ]);
    const n = GOLDEN_DINERO.otros_ingresos.length;
    const fila = p.otros_ingresos[n];
    expect(fila.ingreso_mxn).toBeNull();
    expect(fila.concepto_ingreso).toMatch(/USD sin TC — no suma/);
    expect(p.utilidades_otros_ingresos_mxn).toBe(
      GOLDEN_DINERO.utilidades_otros_ingresos_mxn,
    );
  });
});
