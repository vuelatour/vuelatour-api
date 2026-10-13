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
  BalanceHojaOtrosMovimientosPayload,
  BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  GOLDEN_OM,
  HASTA,
  V2,
  fakeSupabase,
  gastoBase,
  gastoComision,
  mundoCon,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * COMISIÓN DEL VENDEDOR COMO GASTO — Balance general «otros movimientos»
 * (pedido del cliente, 28-sep-2026; invariante 31).
 *
 * «¿Cómo registro el pago de la comisión a Saab para que aparezca en otros
 * movimientos? Si lo capturo como "Otros gastos VuelaTour" queda duplicado.»
 * Los gastos `COMISION_VENDEDOR` del vuelo son el egreso apareado (espejo
 * de las TUAS pagadas), con «faltan/excede» cuando no cuadran con lo
 * cobrado — esos casos (b–f, h) no cambian un byte desde el 0.0.39.
 *
 * SIN ningún gasto, desde el 12-oct-2026 (API 0.0.73, invariante 58; pedido
 * del cliente: «los gastos que todavía no se hacen no deben aparecer»,
 * señalando las filas en amarillo) la línea de comisión NO lleva egreso (ni
 * concepto, ni monto, ni fecha): el ingreso cobrado se queda y el remanente
 * es el ingreso. Hasta el 0.0.72 llevaba la PROVISIÓN por el mismo monto. La
 * hoja viaja con `sin_provision_vendedor: true`.
 *
 * 13-oct-2026 (API 0.0.74, invariante 61): en los vuelos COMPLETADOS de la
 * vigencia con comisión cotizada el pago REAL lo carga el AVIÓN en su
 * columna COMISIONES y la pestaña lo trae apareado con egreso $0.00 «· a
 * cargo del avión …». Los casos b)–h) llaman a `buildOtrosMovimientos` SIN
 * las partes de los aviones (= ningún avión lo absorbe, como antes de la
 * vigencia): VuelaTour lo paga con las ramas de siempre, byte a byte. Los
 * casos b′)/f′)/g′)/h′) pasan por el Balance GENERAL completo (con las
 * partes de los libros) y la vigencia default. La hoja viaja además con
 * `comision_vendedor_solo_gasto_real: true`.
 *
 * Mundo de los specs de ingresos: vuelo #501 (K 20), comisión 80 USD sin
 * IVA ⇒ línea de 1,600.00 MXN; TUAS pagadas 1,500; comisión bancaria 350.
 */

/** Vigencia POSTERIOR a todo el mundo de septiembre: la regla de siempre. */
const POSTERIOR = '2026-12-01';

type PrivadoOM = {
  gastosEmpresaYSueltos: (
    desde: string,
    hasta: string,
  ) => Promise<{ empresa: Fila[]; tuasSueltos: Fila[] }>;
  buildOtrosMovimientos: (
    desde: string,
    hasta: string,
    memoTc: Map<string, unknown>,
    empresaYSueltos: unknown,
  ) => Promise<BalanceHojaOtrosMovimientosPayload>;
  buildPayload: (
    aircraftId: string | null,
    desde: string,
    hasta: string,
  ) => Promise<BalanceAvionPayload>;
};

function servicio(mundo: Record<string, Fila[]>, vigencia?: string) {
  const f = fakeSupabase(mundo);
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    {} as never,
    {
      fecha: (_clave: string, porDefecto: string) =>
        Promise.resolve(vigencia ?? porDefecto),
    } as never,
  );
  return service as unknown as PrivadoOM;
}

/**
 * La pestaña «otros movimientos» del Balance GENERAL completo (con las partes
 * que cada avión ya absorbió) y los libros de sus aviones.
 */
async function balanceGeneral(
  mundo: Record<string, Fila[]>,
  vigencia?: string,
): Promise<{
  om: BalanceHojaOtrosMovimientosPayload;
  aviones: BalanceAvionPayload[];
}> {
  let enviado: {
    consolidado: BalanceAvionPayload;
    aviones: BalanceAvionPayload[];
  } | null = null;
  const service = new AircraftBalanceService(
    fakeSupabase(mundo).supabase as unknown as SupabaseService,
    {
      generateBalanceGeneralXlsx: (p: typeof enviado) => {
        enviado = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
    {
      fecha: (_clave: string, porDefecto: string) =>
        Promise.resolve(vigencia ?? porDefecto),
    } as never,
  );
  await service.xlsxGeneral(DESDE, HASTA);
  const g = enviado as unknown as {
    consolidado: BalanceAvionPayload;
    aviones: BalanceAvionPayload[];
  };
  return { om: g.consolidado.otros_movimientos!, aviones: g.aviones };
}

async function otrosMovimientos(mundo: Record<string, Fila[]>) {
  const priv = servicio(mundo);
  return priv.buildOtrosMovimientos(
    DESDE,
    HASTA,
    new Map(),
    await priv.gastosEmpresaYSueltos(DESDE, HASTA),
  );
}

/** El mundo SIN TUA pagado ni comisión bancaria: la fila del vuelo queda SOLO con la comisión (sin colapsar). */
function mundoSoloComision(gastos: Fila[]): Record<string, Fila[]> {
  const m = mundoCon({
    gastos,
    v1: {
      tuas_usd: 0,
      extras_total_usd: 0,
      monto_total_usd: 2080,
      monto_total_mxn: 41600,
    },
  });
  return {
    ...m,
    gasto: m.gasto.filter((g) => g.id !== 'g-tuas'),
    cobro_vuelo: m.cobro_vuelo.map((c) => ({
      ...c,
      comision_banco_monto: null,
    })),
  };
}

const filaDe = (
  om: BalanceHojaOtrosMovimientosPayload,
  folio: number,
): BalanceOtroMovimientoFilaPayload => {
  const f = om.filas.find((x) => x.clave.endsWith(String(folio)));
  expect(f).toBeDefined();
  return f!;
};

/** Todo el texto de la hoja (conceptos y notas de filas y sueltas). */
const textoHoja = (om: BalanceHojaOtrosMovimientosPayload): string =>
  [...om.filas, ...om.filas_sueltas]
    .flatMap((f) => [
      f.concepto_ingreso,
      f.nota_ingreso,
      f.concepto_egreso,
      f.nota_egreso,
    ])
    .filter(Boolean)
    .join('\n');

describe('«Otros movimientos» — pago REAL al vendedor (COMISION_VENDEDOR, 28-sep-2026)', () => {
  it('a) SIN gasto de comisión: payload BYTE-IDÉNTICO al golden (sin `hay_pago_vendedor_real`, con `sin_provision_vendedor` y `comision_vendedor_solo_gasto_real`) y SIN provisión del vendedor', async () => {
    const om = await otrosMovimientos(mundoCon());
    expect(JSON.stringify(om)).toBe(JSON.stringify(GOLDEN_OM));
    expect(om).not.toHaveProperty('hay_pago_vendedor_real');
    expect(om.sin_provision_vendedor).toBe(true);
    expect(om.comision_vendedor_solo_gasto_real).toBe(true);
    // La fila del #501 (COMPLETADO, sin gasto real): el ingreso cobrado se
    // queda (comisión 1,600 + TUAs 3,000), el egreso son solo las TUAS
    // pagadas y la comisión bancaria, y el remanente = ingreso − egreso.
    const f = filaDe(om, 501);
    expect(f.ingreso_mxn).toBe(4600);
    expect(f.concepto_egreso).toBe(
      'TUAs + comisión bancaria · 2 conceptos (ver nota)',
    );
    expect(f.egreso_mxn).toBe(1850);
    expect(f.remanente_mxn).toBe(2750);
    expect(`${f.concepto_egreso}\n${f.nota_egreso ?? ''}`).not.toMatch(
      /pago comisi[oó]n vendedor|PROVISI[OÓ]N/,
    );
    // NINGÚN texto de provisión en toda la hoja (la marca del amarillo de
    // pyservices es «· PROVISIÓN (»).
    expect(textoHoja(om)).not.toMatch(/PROVISI[OÓ]N \(/);
  });

  it('a2) totales de la hoja: Σ remanentes == Σ ingresos − Σ egresos REALES (la provisión ya no resta)', async () => {
    const om = await otrosMovimientos(mundoCon());
    const todas = [...om.filas, ...om.filas_sueltas];
    const suma = (k: 'ingreso_mxn' | 'egreso_mxn' | 'remanente_mxn') =>
      Math.round(todas.reduce((a, f) => a + (f[k] ?? 0), 0) * 100) / 100;
    expect(suma('ingreso_mxn')).toBe(4600);
    // TUAS 1,500 + comisión bancaria 350 + sueltas (TUAS 80 + gas 250).
    expect(suma('egreso_mxn')).toBe(2180);
    expect(suma('remanente_mxn')).toBe(2420);
    expect(suma('remanente_mxn')).toBe(
      Math.round((suma('ingreso_mxn') - suma('egreso_mxn')) * 100) / 100,
    );
  });

  it('b) 1 gasto exacto de $1,600 MXN ⇒ «gasto real», egreso 3,450, remanente 1,150 (sin provisión)', async () => {
    const om = await otrosMovimientos(
      mundoCon({ gastos: [gastoComision('g-cv', 1600)] }),
    );
    const f = filaDe(om, 501);
    expect(f.nota_egreso).toContain(
      'pago comisión vendedor (Vendedor Uno) · gasto real = $1,600.00',
    );
    expect(f.nota_egreso).not.toContain('PROVISIÓN');
    expect(f.egreso_mxn).toBe(3450);
    expect(f.remanente_mxn).toBe(1150);
    // El ingreso no cambia: la comisión cobrada sigue siendo 1,600.
    expect(f.ingreso_mxn).toBe(GOLDEN_OM.filas[0].ingreso_mxn);
    expect(om.hay_pago_vendedor_real).toBe(true);
    // Sueltas intactas (la comisión NO es un gasto suelto).
    expect(om.filas_sueltas).toEqual(GOLDEN_OM.filas_sueltas);
  });

  it('c) pago PARCIAL de $1,200 ⇒ «parcial: faltan $400.00 MXN», egreso 3,050, remanente 1,550', async () => {
    const om = await otrosMovimientos(
      mundoCon({ gastos: [gastoComision('g-cv', 1200)] }),
    );
    const f = filaDe(om, 501);
    expect(f.nota_egreso).toContain(
      'pago comisión vendedor (Vendedor Uno) · gasto real · parcial: faltan $400.00 MXN = $1,200.00',
    );
    expect(f.egreso_mxn).toBe(3050);
    expect(f.remanente_mxn).toBe(1550);
  });

  it('d) pago EXCEDIDO de $2,000 ⇒ «excede $400.00 MXN», egreso 3,850, remanente 750', async () => {
    const om = await otrosMovimientos(
      mundoCon({ gastos: [gastoComision('g-cv', 2000)] }),
    );
    const f = filaDe(om, 501);
    expect(f.nota_egreso).toContain(
      'pago comisión vendedor (Vendedor Uno) · gasto real · excede $400.00 MXN = $2,000.00',
    );
    expect(f.egreso_mxn).toBe(3850);
    expect(f.remanente_mxn).toBe(750);
  });

  it('e) VARIOS pagos en un vuelo SOLO con comisión ⇒ «(2 pagos)», fecha = la más reciente, remanente 0', async () => {
    const om = await otrosMovimientos(
      mundoSoloComision([
        gastoComision('g-cv-1', 1000, { fecha_gasto: '2026-09-12' }),
        gastoComision('g-cv-2', 600, { fecha_gasto: '2026-09-15' }),
      ]),
    );
    const f = filaDe(om, 501);
    // Una sola línea en el vuelo ⇒ fila SIN colapsar (concepto directo).
    expect(f.concepto_ingreso).toBe('comisión vendedor (Vendedor Uno)');
    expect(f.ingreso_mxn).toBe(1600);
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real (2 pagos)',
    );
    expect(f.egreso_mxn).toBe(1600);
    expect(f.fecha_egreso).toBe('2026-09-15');
    expect(f.remanente_mxn).toBe(0);
  });

  it('e2) control del mismo mundo SIN gasto ⇒ SIN egreso (invariante 58): ni concepto, ni monto, ni fecha; el ingreso se queda y el remanente es el ingreso', async () => {
    const om = await otrosMovimientos(mundoSoloComision([]));
    const f = filaDe(om, 501);
    // Una sola línea en el vuelo ⇒ fila SIN colapsar: la línea de comisión
    // tal cual, con su ingreso y sin ningún egreso.
    expect(f.concepto_ingreso).toBe('comisión vendedor (Vendedor Uno)');
    expect(f.ingreso_mxn).toBe(1600);
    expect(f.fecha_ingreso).toBe('2026-09-10');
    expect(f.concepto_egreso).toBeNull();
    expect(f.egreso_mxn).toBeNull();
    expect(f.fecha_egreso).toBeNull();
    expect(f.nota_egreso ?? null).toBeNull();
    expect(f.remanente_mxn).toBe(1600);
    expect(om).not.toHaveProperty('hay_pago_vendedor_real');
    expect(om.sin_provision_vendedor).toBe(true);
    expect(textoHoja(om)).not.toMatch(/PROVISI[OÓ]N \(|pago comisi[oó]n/);
  });

  it('e3) vuelo CONFIRMADO (aún no realizado) sin gasto ⇒ tampoco provisiona: el egreso son solo TUAS y comisión bancaria', async () => {
    const om = await otrosMovimientos(
      mundoCon({ v1: { estado: 'CONFIRMADO' } }),
    );
    const f = filaDe(om, 501);
    expect(f.estado).toBe('CONFIRMADO');
    expect(f.ingreso_mxn).toBe(4600);
    expect(f.nota_egreso).toBe(
      'tuas pagadas = $1,500.00\ncomisión bancaria = $350.00',
    );
    expect(f.egreso_mxn).toBe(1850);
    expect(f.remanente_mxn).toBe(2750);
    expect(textoHoja(om)).not.toMatch(/PROVISI[OÓ]N \(|pago comisi[oó]n/);
  });

  it('e4) vuelo EXTERNO sin gasto ⇒ sin egreso del vendedor (su comisión cobrada sigue siendo ingreso de VuelaTour)', async () => {
    const om = await otrosMovimientos(
      mundoCon({
        v1: {
          es_externo: true,
          operador_externo: 'XA-TYV',
          costo_externo_usd: 500,
        },
      }),
    );
    const f = filaDe(om, 501);
    expect(f.ingreso_mxn).toBe(4600);
    expect(f.egreso_mxn).toBe(1850);
    expect(f.remanente_mxn).toBe(2750);
    expect(textoHoja(om)).not.toMatch(/PROVISI[OÓ]N \(|pago comisi[oó]n/);
  });

  it('e5) con gasto real NADA cambia: la fila de b) es la de siempre, byte a byte, y la hoja no dice «PROVISIÓN»', async () => {
    const om = await otrosMovimientos(
      mundoCon({ gastos: [gastoComision('g-cv', 1600)] }),
    );
    const f = filaDe(om, 501);
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor + TUAs + comisión bancaria · 3 conceptos (ver nota)',
    );
    expect(f.nota_egreso).toBe(
      [
        'pago comisión vendedor (Vendedor Uno) · gasto real = $1,600.00',
        'tuas pagadas = $1,500.00',
        'comisión bancaria = $350.00',
      ].join('\n'),
    );
    expect([f.ingreso_mxn, f.egreso_mxn, f.remanente_mxn]).toEqual([
      4600, 3450, 1150,
    ]);
    expect(f.fecha_egreso).toBe('2026-09-10');
    expect(om.hay_pago_vendedor_real).toBe(true);
    expect(om.sin_provision_vendedor).toBe(true);
    expect(textoHoja(om)).not.toMatch(/PROVISI[OÓ]N \(/);
  });

  it('f) 80 USD SIN tc_gasto ⇒ se convierte con el T.C. PROMEDIO del periodo (regla del workbook, como las TUAS pagadas)', async () => {
    // #501 con K 20 y #502 con K 18 ⇒ promedio 19 ⇒ 80 × 19 = 1,520.00.
    const om = await otrosMovimientos(
      mundoSoloComision([
        gastoComision('g-cv', 80, { moneda: 'USD', tc_gasto: null }),
      ]),
    );
    // Sin #502 el promedio sería 20; se agrega aquí para forzar 19.
    const om19 = await otrosMovimientos({
      ...mundoSoloComision([
        gastoComision('g-cv', 80, { moneda: 'USD', tc_gasto: null }),
      ]),
      vuelo: [...mundoSoloComision([]).vuelo, vuelo2()],
    });
    expect(filaDe(om, 501).concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real',
    );
    const f = filaDe(om19, 501);
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real · parcial: faltan $80.00 MXN',
    );
    expect(f.egreso_mxn).toBe(1520);
    expect(f.remanente_mxn).toBe(80);
    expect(om19.hay_pago_vendedor_real).toBe(true);
    // Con su tc_gasto propio (20) ⇒ exacto.
    const omTc = await otrosMovimientos({
      ...mundoSoloComision([
        gastoComision('g-cv', 80, { moneda: 'USD', tc_gasto: 20 }),
      ]),
      vuelo: [...mundoSoloComision([]).vuelo, vuelo2()],
    });
    expect(filaDe(omTc, 501).concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real',
    );
    expect(filaDe(omTc, 501).egreso_mxn).toBe(1600);
  });

  it('g) vuelo SIN comisión cobrada con gasto de $500 ⇒ fila de SOLO-egreso (aviso), remanente −500', async () => {
    const om = await otrosMovimientos(
      mundoCon({
        v2: vuelo2(),
        gastos: [
          gastoComision('g-cv', 500, {
            vuelo_id: V2,
            vuelo: { folio: 502, aeronave_id: AV },
          }),
        ],
      }),
    );
    // El vuelo #501 (sin gasto real: sin egreso del vendedor) no cambia.
    expect(filaDe(om, 501)).toEqual(GOLDEN_OM.filas[0]);
    const f = filaDe(om, 502);
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor · sin comisión cobrada en la cotización',
    );
    expect(f.egreso_mxn).toBe(500);
    expect(f.fecha_egreso).toBe('2026-09-10');
    expect(f.concepto_ingreso).toBeNull();
    expect(f.remanente_mxn).toBe(-500);
    expect(om.hay_pago_vendedor_real).toBe(true);
  });

  it('h) vuelo CANCELADO con gasto ⇒ «vuelo cancelado: sin comisión cobrada» (sin provisión, sin ingreso)', async () => {
    const om = await otrosMovimientos(
      mundoCon({
        v1: { estado: 'CANCELADO' },
        gastos: [gastoComision('g-cv', 1600)],
      }),
    );
    const f = filaDe(om, 501);
    expect(f.nota_egreso).toContain(
      'pago comisión vendedor (Vendedor Uno) · vuelo cancelado: sin comisión cobrada = $1,600.00',
    );
    expect(f.nota_egreso).not.toContain('PROVISIÓN');
    expect(f.ingreso_mxn).toBeNull();
  });

  it('partición INCONSISTENTE con comisión cotizada ⇒ solo-egreso «desglose de la cotización inconsistente: sin apareo»', async () => {
    const om = await otrosMovimientos(
      mundoCon({
        // El total no cuadra con los componentes ⇒ p.inconsistente.
        v1: {
          calculo_snapshot: {
            desglose: [
              { clave: 'TIEMPO_VUELO', concepto: 'Vuelo', monto_usd: 2000 },
              {
                clave: 'COMISION_VENDEDOR',
                concepto: 'Comisión',
                monto_usd: 80,
              },
            ],
          },
          monto_total_usd: 9999,
        },
        gastos: [gastoComision('g-cv', 1600)],
      }),
    );
    const f = filaDe(om, 501);
    expect(`${f.concepto_egreso}\n${f.nota_egreso ?? ''}`).toContain(
      'pago comisión vendedor (Vendedor Uno) · desglose de la cotización inconsistente: sin apareo',
    );
  });

  it('i) EXCLUSIÓN: no es costo del avión — fuera de la vigencia el libro sale IDÉNTICO; en la vigencia solo resta en COMISIONES (nunca en OPERACIONES/PILOTO/OTROS ni en el costo); no va a «otros gastos»', async () => {
    // Gasto con vuelo Y avión sellados, fechado FUERA del periodo (si
    // restara en la fila, el pendiente «FUERA del periodo» lo gritaría).
    const comision = gastoComision('g-cv', 1600, { fecha_gasto: '2026-10-05' });
    const fijo = (p: BalanceAvionPayload) =>
      JSON.stringify({ ...p, generado: 'FIJO' });
    // Antes de la vigencia (la regla de siempre): byte a byte.
    const sinAntes = await servicio(mundoCon(), POSTERIOR).buildPayload(
      AV,
      DESDE,
      HASTA,
    );
    const conAntes = await servicio(
      mundoCon({ gastos: [comision] }),
      POSTERIOR,
    ).buildPayload(AV, DESDE, HASTA);
    expect(fijo(conAntes)).toBe(fijo(sinAntes));
    // En la vigencia (default): el pago real resta SOLO en COMISIONES (y lo
    // que deriva: ganancia, cascada) — cuenta en el mes del VUELO aunque se
    // haya capturado en octubre.
    const sin = await servicio(mundoCon()).buildPayload(AV, DESDE, HASTA);
    const con = await servicio(mundoCon({ gastos: [comision] })).buildPayload(
      AV,
      DESDE,
      HASTA,
    );
    expect(
      con.vuelos.find((v) => String(v.folio) === '501')!
        .comision_vendedor_real_mxn,
    ).toBe(1600);
    const fila = con.vuelos.find((v) => String(v.folio) === '501')!;
    const filaSin = sin.vuelos.find((v) => String(v.folio) === '501')!;
    for (const k of [
      'op_mxn',
      'piloto_mxn',
      'otros_mxn',
      'costo_total_mxn',
    ] as const) {
      expect(fila[k]).toBe(filaSin[k]);
    }
    expect(con.pendientes.join(' | ')).not.toMatch(/FUERA del periodo/);
    expect(con.gastos_indirectos).toEqual(sin.gastos_indirectos);
    expect(con.otros_gastos).toEqual(sin.otros_gastos);
    expect(con.permisos).toEqual(sin.permisos);
    // Hoja «otros gastos» del general: la comisión NO entra.
    const { empresa } = await servicio(
      mundoCon({ gastos: [gastoComision('g-cv', 1600)] }),
    ).gastosEmpresaYSueltos(DESDE, HASTA);
    expect(empresa.map((g) => g.id)).not.toContain('g-cv');
  });

  it('i4) EXCLUSIÓN del TC de costos (Z): una comisión MXN CON tc_gasto no mueve la ganancia USD ni el TC promedio del avión', async () => {
    // Revisión adversaria 28-sep: Z = promedio de tc_gasto de los gastos MXN
    // del vuelo. La oficina captura el TC del pago al vendedor (el panel lo
    // pide para MXN) días después del vuelo: sin la exclusión, Z pasaba de
    // K (20) a 19.25 y cambiaban tc_costos, costo/ganancia USD y el TC
    // promedio de TODO el libro del avión.
    const comision = gastoComision('g-cv-tc', 1600, { tc_gasto: 19.25 });
    const fijo = (p: BalanceAvionPayload) =>
      JSON.stringify({ ...p, generado: 'FIJO' });
    // Antes de la vigencia: el libro byte a byte.
    expect(
      fijo(
        await servicio(
          mundoCon({ gastos: [comision] }),
          POSTERIOR,
        ).buildPayload(AV, DESDE, HASTA),
      ),
    ).toBe(
      fijo(
        await servicio(mundoCon(), POSTERIOR).buildPayload(AV, DESDE, HASTA),
      ),
    );
    const sin = await servicio(mundoCon()).buildPayload(AV, DESDE, HASTA);
    const con = await servicio(mundoCon({ gastos: [comision] })).buildPayload(
      AV,
      DESDE,
      HASTA,
    );
    // En la vigencia el pago (MXN, tal cual) resta en COMISIONES, pero su
    // tc_gasto NO mueve Z, la ganancia USD por T.C. ni el T.C. promedio.
    const f = (p: BalanceAvionPayload) =>
      p.vuelos.find((v) => String(v.folio) === '501')!;
    expect(f(con).comision_vendedor_real_mxn).toBe(1600);
    expect(con.tc_promedio).toBe(sin.tc_promedio);
    // Control: el MISMO TC en un gasto DEL AVIÓN sí mueve Z (la regla vive).
    const op: Fila = {
      ...gastoComision('g-op-tc', 100, { tc_gasto: 19.25 }),
      categoria: 'OPERACIONES',
    };
    const conOp = await servicio(mundoCon({ gastos: [op] })).buildPayload(
      AV,
      DESDE,
      HASTA,
    );
    const z = (p: BalanceAvionPayload) =>
      p.vuelos.find((v) => String(v.folio) === '501')!.tc_costos;
    expect(z(sin)).toBe(20);
    expect(z(con)).toBe(20);
    expect(z(conOp)).toBe(19.25);
  });

  it('i5) comisión sellada a OTRO avión (el vuelo cambió de avión): sin el aviso falso «así no aparece en ningún balance»', async () => {
    const AV2 = 'av-2';
    const conAvion2 = (gastos: Fila[]) => {
      const m = mundoCon({ gastos });
      return {
        ...m,
        aeronave: [
          ...m.aeronave,
          { ...m.aeronave[0], id: AV2, matricula: 'XB-OTR' },
        ],
      };
    };
    const comision = gastoComision('g-cv-av2', 1600, { aeronave_id: AV2 });
    const p = await servicio(conAvion2([comision])).buildPayload(
      AV,
      DESDE,
      HASTA,
    );
    // Solo el aviso falso de «avión que no vuela ningún tramo» queda fuera
    // (el pendiente de captura del 0.0.74 tampoco: el pago SÍ está capturado).
    expect(p.pendientes.join(' | ')).not.toMatch(/Comisión del vendedor/);
    // Invariante 61: el avión del gasto es solo referencia — el pago SÍ
    // entra a COMISIONES del avión del VUELO (la lista completa del vuelo).
    const fila = p.vuelos.find((v) => String(v.folio) === '501')!;
    expect(fila.comision_vendedor_real_mxn).toBe(1600);
    expect(fila.comision_vendedor_real_pagos).toBe(1);
    // Control: un gasto DEL AVIÓN en la misma situación sí grita.
    const op: Fila = { ...comision, id: 'g-op-av2', categoria: 'OPERACIONES' };
    const pOp = await servicio(conAvion2([op])).buildPayload(AV, DESDE, HASTA);
    expect(pOp.pendientes.join(' | ')).toMatch(
      /Operaciones.*que no vuela ningún tramo de este vuelo/,
    );
  });

  it('i2) control: la MISMA factura como OTRO (empresa) sí va a «otros gastos» (la comisión es la que no)', async () => {
    const { empresa } = await servicio(
      mundoCon({
        gastos: [{ ...gastoComision('g-otro-v', 1600), categoria: 'OTRO' }],
      }),
    ).gastosEmpresaYSueltos(DESDE, HASTA);
    expect(empresa.map((g) => g.id)).toContain('g-otro-v');
  });

  it('i3) una categoría DEL AVIÓN fuera del periodo SÍ grita (el filtro de fechas sigue vivo)', async () => {
    const op: Fila = {
      ...gastoBase,
      id: 'g-op',
      vuelo_id: 'v-1',
      aeronave_id: AV,
      vuelo: { folio: 501, aeronave_id: AV },
      categoria: 'OPERACIONES',
      monto: 100,
      fecha_gasto: '2026-10-05',
    };
    const p = await servicio(mundoCon({ gastos: [op] })).buildPayload(
      AV,
      DESDE,
      HASTA,
    );
    expect(p.pendientes.join(' | ')).toMatch(/FUERA del periodo/);
  });
  it('b′) VIGENCIA default, #501 COMPLETADO con comisión cotizada, gasto EXACTO de $1,600: el avión lo carga y la pestaña lo trae apareado con egreso $0.00 «a cargo del avión XB-TST ($1,600.00 en su columna COMISIONES)» y la fecha del pago; Σ remanentes == Σ ingresos − Σ egresos REALES', async () => {
    const { om, aviones } = await balanceGeneral(
      mundoSoloComision([
        gastoComision('g-cv', 1600, { fecha_gasto: '2026-09-28' }),
      ]),
    );
    const f = filaDe(om, 501);
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real · a cargo del avión XB-TST ($1,600.00 en su columna COMISIONES)',
    );
    expect([f.ingreso_mxn, f.egreso_mxn, f.remanente_mxn]).toEqual([
      1600, 0, 1600,
    ]);
    expect(f.fecha_egreso).toBe('2026-09-28');
    expect(om.hay_pago_vendedor_real).toBe(true);
    expect(om.comision_vendedor_solo_gasto_real).toBe(true);
    const fila = aviones
      .flatMap((a) => a.vuelos)
      .find((v) => String(v.folio) === '501')!;
    expect(fila.comision_vendedor_real_mxn).toBe(1600);
    const todas = [...om.filas, ...om.filas_sueltas];
    const suma = (k: 'ingreso_mxn' | 'egreso_mxn' | 'remanente_mxn') =>
      Math.round(todas.reduce((a, x) => a + (x[k] ?? 0), 0) * 100) / 100;
    expect(suma('remanente_mxn')).toBe(
      Math.round((suma('ingreso_mxn') - suma('egreso_mxn')) * 100) / 100,
    );
    expect(textoHoja(om)).not.toMatch(/PROVISI[OÓ]N|\bsin TC\b/);
  });

  it('f′) VIGENCIA default, 80 USD SIN tc_gasto con el T.C. promedio de la pestaña (19) ≠ K (20): el avión carga 1,600 (al K) y la pestaña 1,520 (al promedio) ⇒ el sufijo NO imprime cifra («resta en su columna COMISIONES») y el egreso es $0.00', async () => {
    const { om, aviones } = await balanceGeneral({
      ...mundoSoloComision([
        gastoComision('g-cv', 80, { moneda: 'USD', tc_gasto: null }),
      ]),
      vuelo: [...mundoSoloComision([]).vuelo, vuelo2()],
    });
    const f = filaDe(om, 501);
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real · parcial: faltan $80.00 MXN · a cargo del avión XB-TST (resta en su columna COMISIONES)',
    );
    expect(f.egreso_mxn).toBe(0);
    expect(f.remanente_mxn).toBe(f.ingreso_mxn);
    const fila = aviones
      .flatMap((a) => a.vuelos)
      .find((v) => String(v.folio) === '501')!;
    expect(fila.comision_vendedor_real_mxn).toBe(1600);
  });

  it('g′)/h′) VIGENCIA default: un vuelo SIN comisión cotizada o CANCELADO con gasto real ⇒ el avión manda 0 y VuelaTour lo egresa como AVISO de solo-egreso (las ramas de siempre)', async () => {
    const sinLinea = await balanceGeneral(
      mundoCon({
        v2: vuelo2(),
        gastos: [
          gastoComision('g-cv', 500, {
            vuelo_id: V2,
            vuelo: { folio: 502, aeronave_id: AV },
          }),
        ],
      }),
    );
    const f502 = filaDe(sinLinea.om, 502);
    expect(f502.concepto_egreso).toBe(
      'pago comisión vendedor · sin comisión cobrada en la cotización',
    );
    expect(f502.egreso_mxn).toBe(500);
    expect(
      sinLinea.aviones
        .flatMap((a) => a.vuelos)
        .find((v) => String(v.folio) === '502')!.comision_vendedor_real_mxn,
    ).toBe(0);
    const cancelado = await balanceGeneral(
      mundoCon({
        v1: { estado: 'CANCELADO' },
        gastos: [gastoComision('g-cv', 1600)],
      }),
    );
    const f501 = filaDe(cancelado.om, 501);
    expect(f501.nota_egreso ?? f501.concepto_egreso).toContain(
      'pago comisión vendedor (Vendedor Uno) · vuelo cancelado: sin comisión cobrada',
    );
    expect(
      cancelado.aviones
        .flatMap((a) => a.vuelos)
        .find((v) => String(v.folio) === '501')!.comision_vendedor_real_mxn,
    ).toBe(0);
  });
});
