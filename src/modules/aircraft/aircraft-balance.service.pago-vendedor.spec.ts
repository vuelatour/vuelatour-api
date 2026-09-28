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
 * Los gastos `COMISION_VENDEDOR` del vuelo REEMPLAZAN a la PROVISIÓN (espejo
 * de las TUAS pagadas), con «faltan/excede» cuando no cuadran con lo
 * cobrado; sin ningún gasto, la provisión de siempre, BYTE-IDÉNTICA.
 *
 * Mundo de los specs de ingresos: vuelo #501 (K 20), comisión 80 USD sin
 * IVA ⇒ línea de 1,600.00 MXN; TUAS pagadas 1,500; comisión bancaria 350.
 */

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

function servicio(mundo: Record<string, Fila[]>) {
  const f = fakeSupabase(mundo);
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    {} as never,
  );
  return service as unknown as PrivadoOM;
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

describe('«Otros movimientos» — pago REAL al vendedor (COMISION_VENDEDOR, 28-sep-2026)', () => {
  it('a) SIN gasto de comisión: payload BYTE-IDÉNTICO al golden (sin `hay_pago_vendedor_real`)', async () => {
    const om = await otrosMovimientos(mundoCon());
    expect(JSON.stringify(om)).toBe(JSON.stringify(GOLDEN_OM));
    expect(om).not.toHaveProperty('hay_pago_vendedor_real');
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

  it('e2) control del mismo mundo SIN gasto ⇒ la PROVISIÓN de siempre a la fecha del vuelo', async () => {
    const om = await otrosMovimientos(mundoSoloComision([]));
    const f = filaDe(om, 501);
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · PROVISIÓN (mismo monto que lo cobrado: comisión + IVA; sin gasto real capturado)',
    );
    expect(f.egreso_mxn).toBe(1600);
    expect(f.fecha_egreso).toBe('2026-09-10');
    expect(f.remanente_mxn).toBe(0);
    expect(om).not.toHaveProperty('hay_pago_vendedor_real');
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
    // El vuelo #501 (con su provisión) no cambia.
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

  it('i) EXCLUSIÓN: no es costo del avión — el libro del avión sale IDÉNTICO y no va a «otros gastos»', async () => {
    // Gasto con vuelo Y avión sellados, fechado FUERA del periodo (si
    // restara en la fila, el pendiente «FUERA del periodo» lo gritaría).
    const comision = gastoComision('g-cv', 1600, { fecha_gasto: '2026-10-05' });
    const sin = await servicio(mundoCon()).buildPayload(AV, DESDE, HASTA);
    const con = await servicio(mundoCon({ gastos: [comision] })).buildPayload(
      AV,
      DESDE,
      HASTA,
    );
    const fijo = (p: BalanceAvionPayload) =>
      JSON.stringify({ ...p, generado: 'FIJO' });
    expect(fijo(con)).toBe(fijo(sin));
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
    const sin = await servicio(mundoCon()).buildPayload(AV, DESDE, HASTA);
    const con = await servicio(mundoCon({ gastos: [comision] })).buildPayload(
      AV,
      DESDE,
      HASTA,
    );
    const fijo = (p: BalanceAvionPayload) =>
      JSON.stringify({ ...p, generado: 'FIJO' });
    expect(fijo(con)).toBe(fijo(sin));
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
    expect(p.pendientes.join(' | ')).not.toMatch(/Comisión del vendedor/);
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
});
