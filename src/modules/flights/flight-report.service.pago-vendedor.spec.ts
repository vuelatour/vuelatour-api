// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { FlightReportService } from './flight-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ReporteVueloPayload } from '../pyservices/pyservices.service';

/**
 * REPORTE POR VUELO + COMISIÓN DEL VENDEDOR COMO GASTO (28-sep-2026,
 * invariante 31). El reporte resta el pago al vendedor UNA vez — el
 * COTIZADO (`pagoVendedorUsd`) —, así que un gasto `COMISION_VENDEDOR` se
 * LISTA con su detalle pero NO entra al costo, al remanente ni a la
 * ganancia; solo agrega una nota informativa. La nota de «gasto(s) en MXN
 * sin T.C. propio» (de los gastos que SÍ restan) no cambia: la conversión de
 * la nota es PURA (sin el efecto lateral de `gastoUsd`).
 */
type Fila = Record<string, unknown>;
const V = 'v-317';

function vuelo(extra: Fila = {}): Fila {
  return {
    id: V,
    folio: 317,
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
    destino_iata: 'MID',
    pasajeros: 2,
    pasajeros_nombres: null,
    fecha_vuelo: '2026-09-25T15:00:00+00:00',
    fecha_traslado_final: null,
    monto_total_usd: 2230,
    monto_total_mxn: 44600,
    tc_usd_mxn: 20,
    tarifa_tipo: 'PUBLICA',
    tarifa_hora_usd: 1000,
    tiempo_cobrable_hr: 2,
    subtotal_vuelo_usd: 2000,
    tuas_usd: 100,
    iva_usd: 0,
    iva_pct: 0,
    viaticos_pernocta_usd: 0,
    extras_total_usd: 50,
    ajuste_final_usd: 0,
    comision_vendedor_usd: 80,
    comision_vendedor_nombre: 'Alex Saab',
    metodo_cobro: 'TRANSFERENCIA',
    combinado_con_id: null,
    calculo_snapshot: null,
    ...extra,
  };
}

const gasto = (categoria: string, monto: number, extra: Fila = {}): Fila => ({
  fecha_gasto: '2026-09-25',
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
  const from = (tabla: string) => {
    const filas = tablas[tabla] ?? [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'order']) q[m] = () => q;
    q.maybeSingle = () =>
      Promise.resolve({ data: filas[0] ?? null, error: null });
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: filas, error: null }).then(res);
    return q;
  };
  return { service: { from } } as unknown as SupabaseService;
}

async function reporte(v: Fila, gastos: Fila[]): Promise<ReporteVueloPayload> {
  const service = new FlightReportService(
    fake({
      vuelo: [v],
      escala: [],
      cobro_vuelo: [],
      gasto: gastos,
      vuelo_apoyo: [],
    }),
    {} as never,
  );
  return (
    service as unknown as {
      buildPayload: (id: string) => Promise<ReporteVueloPayload>;
    }
  ).buildPayload(V);
}

/** Un gasto que SÍ resta, en MXN y SIN T.C. propio (usa el del vuelo). */
const OPERACION = gasto('OPERACIONES', 400);
const COMISION = gasto('COMISION_VENDEDOR', 1600, {
  notas: 'Pago comisión Saab',
});

const NOTA_TC_VUELO =
  '1 gasto(s) en MXN sin T.C. propio convertidos con el T.C. del vuelo (20).';

describe('Reporte por vuelo — pago REAL al vendedor (COMISION_VENDEDOR, 28-sep-2026)', () => {
  it('se LISTA con su detalle, pero costo, remanente, ganancia y pago al vendedor quedan IDÉNTICOS', async () => {
    const sin = await reporte(vuelo(), [OPERACION]);
    const con = await reporte(vuelo(), [OPERACION, COMISION]);
    for (const k of [
      'gastos_total_usd',
      'combustible_total_usd',
      'gastos_sin_tc_count',
      'remanente_usd',
      'ganancia_final_usd',
      'ganancia_x_hr_usd',
      'ganancia_pct',
      'pago_vendedor_usd',
      'neto_vuelatour_usd',
    ] as const) {
      expect(con[k]).toEqual(sin[k]);
    }
    expect(con.gastos_total_usd).toBe(20); // solo los 400 MXN / 20
    expect(con.pago_vendedor_usd).toBe(80);
    const linea = (con.gastos ?? []).find(
      (g) => g.concepto === 'Comisión del vendedor',
    );
    expect(linea).toBeDefined();
    expect(linea!.detalle).toBe(
      'Pago comisión Saab · pago al vendedor — ya descontado en «pago al vendedor» (no resta aparte)',
    );
    expect(linea!.monto).toBe(1600);
  });

  it('nota informativa con lo pagado de verdad y el cotizado que se resta; la nota de T.C. del vuelo NO cambia', async () => {
    const sin = await reporte(vuelo(), [OPERACION]);
    const con = await reporte(vuelo(), [OPERACION, COMISION]);
    expect(sin.notas_horas).toContain(NOTA_TC_VUELO);
    // Sin efecto lateral: la comisión (MXN sin T.C. propio) NO sube el conteo.
    expect(con.notas_horas).toContain(NOTA_TC_VUELO);
    expect(con.notas_horas).toContain(
      'Pago real al vendedor capturado: $80 USD en 1 gasto(s) (la ganancia de este reporte resta el pago cotizado de $80 USD).',
    );
    // Lo ÚNICO nuevo en las notas es esa línea.
    expect(
      (con.notas_horas ?? []).filter(
        (n) => !(sin.notas_horas ?? []).includes(n),
      ),
    ).toEqual([
      'Pago real al vendedor capturado: $80 USD en 1 gasto(s) (la ganancia de este reporte resta el pago cotizado de $80 USD).',
    ]);
  });

  it('sin gastos de la categoría NO hay nota (reporte byte-idéntico)', async () => {
    const r = await reporte(vuelo(), [OPERACION]);
    expect((r.notas_horas ?? []).join(' | ')).not.toMatch(
      /Pago real al vendedor/,
    );
  });

  it('USD directo + MXN con su tc_gasto; sin ningún T.C. se omite el monto', async () => {
    const r = await reporte(vuelo(), [
      gasto('COMISION_VENDEDOR', 50, { moneda: 'USD' }),
      gasto('COMISION_VENDEDOR', 610.5, { tc_gasto: 20.35 }),
    ]);
    expect(r.notas_horas).toContain(
      'Pago real al vendedor capturado: $80 USD en 2 gasto(s) (la ganancia de este reporte resta el pago cotizado de $80 USD).',
    );
    const sinTc = await reporte(
      vuelo({ tc_usd_mxn: null, monto_total_mxn: null }),
      [gasto('COMISION_VENDEDOR', 1600)],
    );
    expect(sinTc.notas_horas).toContain(
      'Pago real al vendedor capturado en 1 gasto(s) (la ganancia de este reporte resta el pago cotizado de $80 USD).',
    );
    // Y, sin T.C., tampoco cuenta como «gasto sin tipo de cambio» del costo.
    expect(sinTc.gastos_sin_tc_count).toBe(0);
  });

  it('vuelo CANCELADO ⇒ variante «este reporte no resta pago al vendedor»', async () => {
    const r = await reporte(vuelo({ estado: 'CANCELADO' }), [COMISION]);
    expect(r.notas_horas).toContain(
      'Pago real al vendedor capturado: $80 USD en 1 gasto(s) (vuelo cancelado: este reporte no resta pago al vendedor).',
    );
  });

  it('EXTERNO: el aviso «gasto(s) ADEMÁS del costo del operador» NO cuenta la comisión', async () => {
    const externo = vuelo({ es_externo: true, costo_externo_usd: 500 });
    const soloComision = await reporte(externo, [COMISION]);
    expect((soloComision.notas_horas ?? []).join(' | ')).not.toMatch(
      /Vuelo externo con/,
    );
    const conOperacion = await reporte(externo, [OPERACION, COMISION]);
    expect(conOperacion.notas_horas).toContain(
      'Vuelo externo con 1 gasto(s) capturado(s) ADEMÁS del costo del operador: verifica que el pago al operador no esté también capturado como gasto (se contaría doble).',
    );
    // Control byte-idéntico: sin la comisión, el aviso de siempre.
    const control = await reporte(externo, [OPERACION]);
    expect(control.notas_horas).toContain(
      'Vuelo externo con 1 gasto(s) capturado(s) ADEMÁS del costo del operador: verifica que el pago al operador no esté también capturado como gasto (se contaría doble).',
    );
  });
});
