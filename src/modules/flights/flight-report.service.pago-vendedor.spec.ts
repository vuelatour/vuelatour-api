// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { FlightReportService } from './flight-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ReporteVueloPayload } from '../pyservices/pyservices.service';

/**
 * REPORTE POR VUELO + PAGO AL VENDEDOR (28-sep-2026, invariante 31;
 * 13-oct-2026, decisión 3 del cliente «en todo: solo gastos reales»,
 * invariante 73). La ganancia del reporte resta el pago al vendedor UNA vez
 * y es el pago REAL: la Σ de los gastos del vuelo de las DOS categorías
 * («Comisión del vendedor (VuelaTour)» y «(avión)»), convertidos con la
 * regla de `gastoUsd` pero sin su efecto lateral. Sin gasto real no se resta
 * nada (antes: el COTIZADO `pagoVendedorUsd`). Los gastos se LISTAN con su
 * detalle y NO entran al costo ni al remanente.
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
/** El pago REAL: $2,000 MXN ÷ T.C. del vuelo 20 = $100 USD (cotizado: $80). */
const COMISION = gasto('COMISION_VENDEDOR', 2000, {
  notas: 'Pago comisión Saab',
});

const NOTA_TC_VUELO =
  '1 gasto(s) en MXN sin T.C. propio convertidos con el T.C. del vuelo (20).';
const NOTA_REAL_100 =
  'Pago real al vendedor capturado: $100 USD en 1 gasto(s); la ganancia de este reporte resta este pago real (la comisión cotizada con su IVA es de $80 USD).';
const NOTA_SIN_REAL =
  'Comisión del vendedor cotizada $80 USD sin gasto real capturado: la ganancia de este reporte no resta pago al vendedor (si ya se pagó, captúralo en Gastos como «Comisión del vendedor (VuelaTour)» o «Comisión del vendedor (avión)» ligado a este vuelo).';

describe('Reporte por vuelo — pago al vendedor SOLO REAL (decisión 3, invariante 73)', () => {
  it('la ganancia resta el pago REAL; el gasto se LISTA y NO entra al costo ni al remanente', async () => {
    const sin = await reporte(vuelo(), [OPERACION]);
    const con = await reporte(vuelo(), [OPERACION, COMISION]);
    for (const k of [
      'gastos_total_usd',
      'combustible_total_usd',
      'gastos_sin_tc_count',
      'remanente_usd',
    ] as const) {
      expect(con[k]).toEqual(sin[k]);
    }
    expect(con.gastos_total_usd).toBe(20); // solo los 400 MXN / 20
    expect(con.remanente_usd).toBe(2210);
    // Pago REAL ($100), no el cotizado ($80).
    expect(con.pago_vendedor_usd).toBe(100);
    expect(con.ganancia_final_usd).toBe(2110);
    expect(con.neto_vuelatour_usd).toBe(2130);
    expect(con.ganancia_x_hr_usd).toBe(1055);
    const linea = (con.gastos ?? []).find(
      (g) => g.concepto === 'Comisión del vendedor (VuelaTour)',
    );
    expect(linea).toBeDefined();
    expect(linea!.detalle).toBe(
      'Pago comisión Saab · pago al vendedor — ya descontado en «pago al vendedor» (no resta aparte)',
    );
    expect(linea!.monto).toBe(2000);
  });

  it('sin gasto real NO se resta nada: pago 0 explícito, neto = total y la nota «cotizada sin gasto real»', async () => {
    const r = await reporte(vuelo(), [OPERACION]);
    expect(r.pago_vendedor_usd).toBe(0);
    expect(r.neto_vuelatour_usd).toBe(2230);
    expect(r.ganancia_final_usd).toBe(r.remanente_usd);
    expect(r.comision_vendedor_usd).toBe(80);
    expect(r.notas_horas).toContain(NOTA_SIN_REAL);
    expect((r.notas_horas ?? []).join(' | ')).not.toMatch(
      /Pago real al vendedor/,
    );
  });

  it('nota con lo pagado y lo cotizado; la nota de T.C. del vuelo NO cambia (sin efecto lateral)', async () => {
    const sin = await reporte(vuelo(), [OPERACION]);
    const con = await reporte(vuelo(), [OPERACION, COMISION]);
    expect(sin.notas_horas).toContain(NOTA_TC_VUELO);
    // La comisión (MXN sin T.C. propio) NO sube el conteo de los costos.
    expect(con.notas_horas).toContain(NOTA_TC_VUELO);
    expect(con.notas_horas).toContain(NOTA_REAL_100);
    // Con pago real no va la nota de «sin gasto real».
    expect(con.notas_horas).not.toContain(NOTA_SIN_REAL);
  });

  it('USD directo + MXN con su tc_gasto; un MXN sin ningún T.C. NO se resta y se AVISA (no es «gasto sin T.C.» del costo)', async () => {
    const r = await reporte(vuelo(), [
      gasto('COMISION_VENDEDOR', 50, { moneda: 'USD' }),
      gasto('COMISION_VENDEDOR', 610.5, { tc_gasto: 20.35 }),
    ]);
    expect(r.pago_vendedor_usd).toBe(80);
    expect(r.notas_horas).toContain(
      'Pago real al vendedor capturado: $80 USD en 2 gasto(s); la ganancia de este reporte resta este pago real (la comisión cotizada con su IVA es de $80 USD).',
    );
    const sinTc = await reporte(
      vuelo({ tc_usd_mxn: null, monto_total_mxn: null }),
      [
        gasto('COMISION_VENDEDOR', 1600),
        gasto('COMISION_VENDEDOR', 30, { moneda: 'USD' }),
      ],
    );
    // Solo los $30 USD se restan; los $1,600 MXN sin T.C. se avisan.
    expect(sinTc.pago_vendedor_usd).toBe(30);
    expect(sinTc.ganancia_final_usd).toBe(
      Number(((sinTc.remanente_usd ?? 0) - 30).toFixed(2)),
    );
    expect(sinTc.notas_horas).toContain(
      'Pago real al vendedor capturado: $30 USD en 1 gasto(s); la ganancia de este reporte resta este pago real (la comisión cotizada con su IVA es de $80 USD).',
    );
    expect(sinTc.notas_horas).toContain(
      '1 pago(s) al vendedor en MXN por $1,600 SIN tipo de cambio (y el vuelo no tiene T.C.): no se restan de la ganancia — captura su T.C. en Gastos.',
    );
    expect(sinTc.gastos_sin_tc_count).toBe(0);
  });

  it('las DOS categorías suman: «(VuelaTour)» + «(avión)» (13-oct-2026, invariante 61)', async () => {
    const sin = await reporte(vuelo(), [OPERACION]);
    const con = await reporte(vuelo(), [
      OPERACION,
      gasto('COMISION_VENDEDOR', 1000, { notas: 'Parte VuelaTour' }),
      gasto('COMISION_VENDEDOR_AVION', 600, { notas: 'Pago comisión Saab' }),
    ]);
    for (const k of ['gastos_total_usd', 'remanente_usd'] as const) {
      expect(con[k]).toEqual(sin[k]);
    }
    // (1,000 + 600) MXN ÷ 20 = $80 USD.
    expect(con.pago_vendedor_usd).toBe(80);
    expect(con.ganancia_final_usd).toBe(
      Number(((sin.remanente_usd ?? 0) - 80).toFixed(2)),
    );
    const linea = (con.gastos ?? []).find(
      (g) => g.concepto === 'Comisión del vendedor (avión)',
    );
    expect(linea!.detalle).toBe(
      'Pago comisión Saab · pago al vendedor — ya descontado en «pago al vendedor» (no resta aparte)',
    );
    expect(con.notas_horas).toContain(
      'Pago real al vendedor capturado: $80 USD en 2 gasto(s); la ganancia de este reporte resta este pago real (la comisión cotizada con su IVA es de $80 USD).',
    );
  });

  it('vuelo SIN comisión cotizada con pago real (caso #332): se resta y la nota no cita cotizada; sin comisión ni pagos: null', async () => {
    const sinComision = vuelo({
      comision_vendedor_usd: 0,
      comision_vendedor_nombre: null,
      monto_total_usd: 2150,
    });
    const r = await reporte(sinComision, [
      OPERACION,
      gasto('COMISION_VENDEDOR', 1305),
    ]);
    expect(r.pago_vendedor_usd).toBe(65.25);
    expect(r.ganancia_final_usd).toBe(
      Number(((r.remanente_usd ?? 0) - 65.25).toFixed(2)),
    );
    expect(r.notas_horas).toContain(
      'Pago real al vendedor capturado: $65.25 USD en 1 gasto(s); la ganancia de este reporte resta este pago real.',
    );
    const nada = await reporte(sinComision, [OPERACION]);
    expect(nada.pago_vendedor_usd).toBeNull();
    expect(nada.neto_vuelatour_usd).toBeNull();
    expect((nada.notas_horas ?? []).join(' | ')).not.toMatch(
      /Pago real al vendedor|Comisión del vendedor cotizada|pago\(s\) al vendedor/,
    );
  });

  it('CANCELADO: con pago real se resta (dinero que sí salió); sin pago, la nota del cancelado y el neto = lo retenido', async () => {
    const con = await reporte(vuelo({ estado: 'CANCELADO' }), [
      gasto('COMISION_VENDEDOR', 1600),
    ]);
    expect(con.pago_vendedor_usd).toBe(80);
    expect(con.ganancia_final_usd).toBe(
      Number(((con.remanente_usd ?? 0) - 80).toFixed(2)),
    );
    // Sin cobros retenidos: lo retenido (0) − el pago.
    expect(con.neto_vuelatour_usd).toBe(-80);
    expect(con.notas_horas).toContain(
      'Pago real al vendedor capturado: $80 USD en 1 gasto(s); el vuelo se canceló, pero es dinero que sí salió: la ganancia de este reporte lo resta.',
    );
    const sin = await reporte(vuelo({ estado: 'CANCELADO' }), []);
    expect(sin.pago_vendedor_usd).toBe(0);
    expect(sin.neto_vuelatour_usd).toBe(0);
    expect(sin.notas_horas).toContain(
      'Vuelo CANCELADO: comisión del vendedor cotizada $80 USD sin gasto real capturado; este reporte no resta pago al vendedor y el neto de VuelaTour es lo retenido.',
    );
  });

  it('aditivos: bandera comision_vendedor_solo_gasto_real y la cotizada como DATO (un pyservices previo los ignora)', async () => {
    const r = await reporte(vuelo(), [OPERACION, COMISION]);
    expect(r.comision_vendedor_solo_gasto_real).toBe(true);
    // La cotizada viaja como dato y NO es lo que resta la ganancia.
    expect(r.pago_vendedor_cotizado_usd).toBe(80);
    expect(r.pago_vendedor_usd).toBe(100);
    const sinComision = await reporte(
      vuelo({ comision_vendedor_usd: 0, monto_total_usd: 2150 }),
      [OPERACION],
    );
    expect(sinComision.pago_vendedor_cotizado_usd).toBeNull();
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
