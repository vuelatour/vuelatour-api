// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// AFAC POR VUELO (invariante 90): con la migración 20261016000005.
jest.mock('../../common/afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/afac-real-disponible.util',
  ),
  afacRealDisponible: jest.fn(() => Promise.resolve(true)),
}));

import { FlightReportService } from './flight-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ReporteVueloPayload } from '../pyservices/pyservices.service';

/**
 * REPORTE POR VUELO + PAGO DE AFAC MARCADO (16-oct-2026, invariante 90;
 * revisión adversaria del lote AFAC). Decisión 4 del cliente: los gastos
 * marcados «Pago de AFAC» los paga VuelaTour y DEJAN DE RESTARLE AL AVIÓN.
 * El reporte por vuelo los restaba en su REMANENTE (lector que la tabla de
 * lectores del contrato no listaba): ahora se LISTAN con su nota y NO entran
 * al costo, igual que un gasto de empresa. Un PERMISO SIN marca sigue
 * restando como siempre.
 */
type Fila = Record<string, unknown>;
const V = 'v-280';

function vuelo(): Fila {
  return {
    id: V,
    folio: 280,
    cliente_id: null,
    aeronave_id: null,
    piloto_id: null,
    copiloto_id: null,
    tipo: 'CHARTER',
    estado: 'COMPLETADO',
    es_externo: false,
    operador_externo: null,
    costo_externo_usd: null,
    origen_iata: 'CUN',
    destino_iata: 'CTM',
    pasajeros: 2,
    pasajeros_nombres: null,
    fecha_vuelo: '2026-09-10T15:00:00+00:00',
    fecha_traslado_final: null,
    monto_total_usd: 2000,
    monto_total_mxn: 40000,
    tc_usd_mxn: 20,
    tarifa_tipo: 'PUBLICA',
    tarifa_hora_usd: 1000,
    tiempo_cobrable_hr: 2,
    subtotal_vuelo_usd: 2000,
    tuas_usd: 0,
    iva_usd: 0,
    iva_pct: 0,
    viaticos_pernocta_usd: 0,
    extras_total_usd: 0,
    ajuste_final_usd: 0,
    comision_vendedor_usd: 0,
    comision_vendedor_nombre: null,
    metodo_cobro: 'TRANSFERENCIA',
    combinado_con_id: null,
    calculo_snapshot: null,
  };
}

const gasto = (categoria: string, monto: number, extra: Fila = {}): Fila => ({
  fecha_gasto: '2026-09-10',
  categoria,
  monto,
  moneda: 'MXN',
  tc_gasto: null,
  litros: null,
  lugar: null,
  notas: null,
  proveedor: null,
  ...extra,
});

function fake(tablas: Record<string, Fila[]>) {
  const selects: Array<{ tabla: string; cols: unknown }> = [];
  const from = (tabla: string) => {
    const filas = tablas[tabla] ?? [];
    const q: Record<string, unknown> = {};
    for (const m of ['eq', 'is', 'in', 'order', 'limit']) q[m] = () => q;
    q.select = (cols: unknown) => {
      selects.push({ tabla, cols });
      return q;
    };
    q.maybeSingle = () =>
      Promise.resolve({ data: filas[0] ?? null, error: null });
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: filas, error: null }).then(res);
    return q;
  };
  return {
    supabase: { service: { from } } as unknown as SupabaseService,
    selects,
  };
}

async function reporte(gastos: Fila[]) {
  const f = fake({
    vuelo: [vuelo()],
    escala: [],
    cobro_vuelo: [],
    gasto: gastos,
    vuelo_apoyo: [],
  });
  const service = new FlightReportService(f.supabase, {} as never);
  const r = await (
    service as unknown as {
      buildPayload: (id: string) => Promise<ReporteVueloPayload>;
    }
  ).buildPayload(V);
  return { r, selects: f.selects };
}

/** Un gasto que SÍ resta: $400 MXN ÷ T.C. del vuelo 20 = $20 USD. */
const OPERACION = gasto('OPERACIONES', 400);
/** «mochada al comandante de AFAC MMCT» (#280, XB-PEV): $1,000 MXN. */
const PERMISO = gasto('PERMISO', 1000, {
  notas: 'mochada al comandante de AFAC MMCT',
});

describe('Reporte por vuelo — PAGO DE AFAC marcado (invariante 90)', () => {
  it('con la migración el gasto del vuelo se lee con `es_pago_afac`', async () => {
    const { selects } = await reporte([OPERACION]);
    const sel = selects.find((s) => s.tabla === 'gasto');
    expect(String(sel?.cols)).toContain('es_pago_afac');
  });

  it('un PERMISO SIN marca resta en el remanente del vuelo (como siempre)', async () => {
    const base = (await reporte([OPERACION])).r;
    const sin = (
      await reporte([OPERACION, { ...PERMISO, es_pago_afac: false }])
    ).r;
    expect(base.gastos_total_usd).toBe(20);
    expect(sin.gastos_total_usd).toBe(70); // + 1000 / 20
    expect(sin.remanente_usd).toBe(
      Number(((base.remanente_usd ?? 0) - 50).toFixed(2)),
    );
  });

  it('MARCADO «Pago de AFAC»: se LISTA con su nota y NO resta (costo, remanente y conteo de T.C. iguales a sin el gasto)', async () => {
    const base = (await reporte([OPERACION])).r;
    const con = (await reporte([OPERACION, { ...PERMISO, es_pago_afac: true }]))
      .r;
    for (const k of [
      'gastos_total_usd',
      'combustible_total_usd',
      'gastos_sin_tc_count',
      'remanente_usd',
      'ganancia_final_usd',
    ] as const) {
      expect(con[k]).toEqual(base[k]);
    }
    expect(con.notas_horas).toEqual(base.notas_horas);
    const linea = (con.gastos ?? []).find((g) => g.monto === 1000);
    expect(linea).toBeDefined();
    expect(linea!.detalle).toBe(
      'mochada al comandante de AFAC MMCT · pago de AFAC (lo paga VuelaTour) — no resta al vuelo',
    );
  });

  it('la marca en otra categoría NO cuenta (fuente única: solo PERMISO)', async () => {
    const base = (await reporte([OPERACION])).r;
    const otro = (
      await reporte([
        OPERACION,
        gasto('OPERACIONES', 1000, { es_pago_afac: true }),
      ])
    ).r;
    expect(otro.gastos_total_usd).toBe((base.gastos_total_usd ?? 0) + 50);
  });
});
