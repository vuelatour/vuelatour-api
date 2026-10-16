// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { FlightReportService } from './flight-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ReporteVueloPayload } from '../pyservices/pyservices.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';

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

async function reporte(
  v: Fila,
  gastos: Fila[],
  opts: { tipoCambio?: TipoCambioService; cobros?: Fila[] } = {},
): Promise<ReporteVueloPayload> {
  const service = new FlightReportService(
    fake({
      vuelo: [v],
      escala: [],
      cobro_vuelo: opts.cobros ?? [],
      gasto: gastos,
      vuelo_apoyo: [],
    }),
    {} as never,
    opts.tipoCambio,
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

/**
 * K DE LOS LIBROS (revisión del lote 2, 14-oct-2026): un vuelo SIN T.C. en la
 * cotización convierte lo que está en pesos sin T.C. propio con el T.C.
 * OFICIAL del día Cancún de la COTIZACIÓN (el MISMO del balance por avión y
 * del reparto). Caso real #70 (jul, Saab, comisión 115 USD, sin T.C.): un
 * pago al vendedor capturado en MXN sin T.C. dejaba de restarse aquí y SÍ se
 * restaba en los libros.
 */
describe('Reporte por vuelo — K de los libros (capturado ?? oficial del día de la cotización)', () => {
  const OFICIAL = 17.3943;
  function tipoCambioFalso(tc: number | null) {
    const oficialDetallePara = jest.fn((dia: string) =>
      Promise.resolve(
        tc == null
          ? null
          : {
              tc,
              fecha_dato: dia === '2026-07-21' ? '2026-07-21' : dia,
              fuente: 'open.er-api',
            },
      ),
    );
    return {
      oficialDetallePara,
      servicio: { oficialDetallePara } as unknown as TipoCambioService,
    };
  }
  /** #70: cotizado el 21-jul (03:30Z del 22 = 21 en Cancún), voló el 23-jul. */
  const SIN_TC = vuelo({
    tc_usd_mxn: null,
    monto_total_mxn: null,
    fecha_solicitud: '2026-07-22T03:30:00+00:00',
    fecha_vuelo: '2026-07-23T15:00:00+00:00',
  });
  const NOTA_OFICIAL =
    'El vuelo no tiene T.C. en la cotización: lo que está en pesos sin T.C. propio (cobros, gastos y pagos al vendedor) se convirtió con el T.C. oficial de referencia del día de la cotización, 17.3943 (dato del 2026-07-21, fuente open.er-api) — el mismo que usan el balance por avión y el reparto.';

  it('el pago al vendedor en MXN sin T.C. SÍ se resta con el oficial del día de la cotización (antes: no se restaba)', async () => {
    const tc = tipoCambioFalso(OFICIAL);
    const r = await reporte(
      SIN_TC,
      [OPERACION, gasto('COMISION_VENDEDOR', 2000)],
      {
        tipoCambio: tc.servicio,
      },
    );
    // Día Cancún de `fecha_solicitud` (no el UTC ni el del vuelo).
    expect(tc.oficialDetallePara).toHaveBeenCalledWith('2026-07-21');
    expect(r.pago_vendedor_usd).toBe(114.98);
    expect(r.gastos_total_usd).toBe(23);
    expect(r.ganancia_final_usd).toBe(
      Number(((r.remanente_usd ?? 0) - 114.98).toFixed(2)),
    );
    expect(r.notas_horas).toContain(
      '1 gasto(s) en MXN sin T.C. propio convertidos con el T.C. oficial del día de la cotización (17.3943).',
    );
    expect(r.notas_horas).toContain(NOTA_OFICIAL);
    expect((r.notas_horas ?? []).join(' | ')).not.toMatch(/SIN tipo de cambio/);
    // El T.C. del payload sigue siendo el CAPTURADO (columna MXN del PDF).
    expect(r.tc_usd_mxn).toBeNull();
  });

  it('cobros en MXN sin T.C. propio también se convierten con el mismo K', async () => {
    const tc = tipoCambioFalso(OFICIAL);
    const r = await reporte(SIN_TC, [], {
      tipoCambio: tc.servicio,
      cobros: [
        {
          monto: 34788.6,
          moneda: 'MXN',
          tc_usd_mxn: null,
          metodo_cobro: 'TRANSFERENCIA',
          fecha_cobro: '2026-07-23',
          comision_banco_pct: null,
          comision_banco_monto: null,
        },
      ],
    });
    expect(r.total_cobrado_usd).toBe(2000);
    expect(r.notas_horas).toContain(NOTA_OFICIAL);
    expect((r.notas_horas ?? []).join(' | ')).not.toMatch(
      /sin tipo de cambio: NO están en el total cobrado/,
    );
  });

  it('con T.C. capturado NO se consulta el oficial; sin dato oficial, como antes (se avisa, no se resta)', async () => {
    const tc = tipoCambioFalso(OFICIAL);
    const con = await reporte(vuelo(), [OPERACION, COMISION], {
      tipoCambio: tc.servicio,
    });
    expect(tc.oficialDetallePara).not.toHaveBeenCalled();
    expect(con.pago_vendedor_usd).toBe(100);
    expect(con.notas_horas).toContain(NOTA_TC_VUELO);
    expect((con.notas_horas ?? []).join(' | ')).not.toMatch(/T\.C\. oficial/);

    const sinDato = await reporte(SIN_TC, [gasto('COMISION_VENDEDOR', 1600)], {
      tipoCambio: tipoCambioFalso(null).servicio,
    });
    expect(sinDato.pago_vendedor_usd).toBe(0);
    expect(sinDato.notas_horas).toContain(
      '1 pago(s) al vendedor en MXN por $1,600 SIN tipo de cambio (y el vuelo no tiene T.C.): no se restan de la ganancia — captura su T.C. en Gastos.',
    );
    expect((sinDato.notas_horas ?? []).join(' | ')).not.toMatch(
      /T\.C\. oficial de referencia/,
    );
  });

  it('todo en dólares: el oficial no se usa y su nota no sale', async () => {
    const r = await reporte(
      SIN_TC,
      [gasto('COMISION_VENDEDOR', 50, { moneda: 'USD' })],
      { tipoCambio: tipoCambioFalso(OFICIAL).servicio },
    );
    expect(r.pago_vendedor_usd).toBe(50);
    expect(r.notas_horas).not.toContain(NOTA_OFICIAL);
  });
});

/**
 * EL PAGO AL OPERADOR EXTERNO ES EL GASTO REAL (16-oct-2026, invariante 88;
 * misma filosofía que la 73). Caso real #308 (CarlosMuciño, T.C. 17): costo
 * capturado 1,490.26 USD Y el gasto NUCLEUM de $25,334.40 que ES su pago.
 * El reporte restaba los dos; ahora el costo se cuenta UNA vez, con el gasto.
 */
describe('Reporte por vuelo — el gasto real cubre el costo del operador externo (invariante 88)', () => {
  const EXT = {
    es_externo: true,
    operador_externo: 'CarlosMuciño',
    costo_externo_usd: '1490.26',
    tc_usd_mxn: 17,
    comision_vendedor_usd: 0,
  };
  const NUCLEUM = gasto('OPERACIONES', 25334.4, {
    id: 'g-nucleum',
    fecha_gasto: '2026-09-15',
    notas: 'VLO PTU 10 SEPTIEMBRE XBORN · Proveedor: NUCLEUM SA DE CV',
  });
  const PISTA = gasto('OPERACIONES', 1118.12, {
    id: 'g-pista',
    fecha_gasto: '2026-09-10',
    notas: 'pago pista ptu',
  });
  const NOTA_CUBIERTO =
    'Costo operador externo (CarlosMuciño) $1,490.26 USD — cubierto por el gasto «Operaciones · VLO PTU 10 SEPTIEMBRE XBORN · Proveedor: NUCLEUM SA DE CV» (no se suma dos veces).';
  const lineaCosto = (r: ReporteVueloPayload) =>
    (r.gastos ?? []).filter((g) => g.concepto === 'Costo operador externo');

  it('#308: costo + gasto igual ⇒ el costo del vuelo cuenta el gasto UNA vez', async () => {
    const r = await reporte(vuelo(EXT), [PISTA, NUCLEUM]);
    // (1,118.12 + 25,334.40) ÷ 17 = 1,556.03 (antes + 1,490.26 = 3,046.29).
    expect(r.gastos_total_usd).toBe(1556.03);
    expect(lineaCosto(r)).toEqual([]);
    expect(r.notas_horas).toContain(NOTA_CUBIERTO);
    expect((r.notas_horas ?? []).join(' | ')).not.toMatch(/ADEMÁS del costo/);
    const nuc = (r.gastos ?? []).find((g) =>
      (g.detalle ?? '').includes('NUCLEUM'),
    );
    expect(nuc?.detalle).toContain(
      'pago al operador externo — cubre el costo capturado (no se suma dos veces)',
    );
    expect(nuc?.monto).toBe(25334.4);
  });

  it('#290: solo gasto, sin costo ⇒ igual que hoy', async () => {
    const r = await reporte(
      vuelo({ ...EXT, costo_externo_usd: null, tc_usd_mxn: 16.92166 }),
      [gasto('OPERACIONES', 11046.6)],
    );
    expect(r.gastos_total_usd).toBe(Number((11046.6 / 16.92166).toFixed(2)));
    expect(lineaCosto(r)).toEqual([]);
    expect(r.notas_horas).toContain(
      'Vuelo externo SIN costo del operador capturado: la ganancia mostrada es BRUTA (no se ha restado lo que cobra el operador).',
    );
  });

  it('costo sin gasto que coincida ⇒ igual que hoy (línea del costo + aviso)', async () => {
    const solo = await reporte(vuelo(EXT), []);
    expect(solo.gastos_total_usd).toBe(1490.26);
    expect(lineaCosto(solo)).toHaveLength(1);
    const conPista = await reporte(vuelo(EXT), [PISTA]);
    expect(conPista.gastos_total_usd).toBe(
      Number((1118.12 / 17 + 1490.26).toFixed(2)),
    );
    expect(conPista.notas_horas).toContain(
      'Vuelo externo con 1 gasto(s) capturado(s) ADEMÁS del costo del operador: verifica que el pago al operador no esté también capturado como gasto (se contaría doble).',
    );
  });

  it('dos gastos coinciden ⇒ cubre el más cercano; el otro se avisa como posible duplicado', async () => {
    const otro = gasto('OPERACIONES', 25400, {
      id: 'g-otro',
      fecha_gasto: '2026-09-12',
      notas: 'transferencia muciño',
    });
    const r = await reporte(vuelo(EXT), [otro, NUCLEUM]);
    expect(r.gastos_total_usd).toBe(
      Number(((25400 + 25334.4) / 17).toFixed(2)),
    );
    expect(lineaCosto(r)).toEqual([]);
    expect(r.notas_horas).toContain(NOTA_CUBIERTO);
    expect(r.notas_horas).toContain(
      'Vuelo externo con 1 gasto(s) más que también coinciden con el costo del operador: posible pago duplicado — verifica en Gastos (se contaría doble).',
    );
  });

  it('gasto en USD vs costo en USD ⇒ cubre', async () => {
    const r = await reporte(vuelo({ ...EXT, costo_externo_usd: 1000 }), [
      gasto('OPERACIONES', 1000, { moneda: 'USD', notas: 'wire' }),
    ]);
    expect(r.gastos_total_usd).toBe(1000);
    expect(lineaCosto(r)).toEqual([]);
  });

  it('CANCELADO ⇒ igual que hoy (el reporte no cambia)', async () => {
    const r = await reporte(vuelo({ ...EXT, estado: 'CANCELADO' }), [NUCLEUM]);
    expect(lineaCosto(r)).toHaveLength(1);
    expect(r.gastos_total_usd).toBe(
      Number((25334.4 / 17 + 1490.26).toFixed(2)),
    );
    expect((r.notas_horas ?? []).join(' | ')).not.toMatch(/cubierto por/);
  });
});
