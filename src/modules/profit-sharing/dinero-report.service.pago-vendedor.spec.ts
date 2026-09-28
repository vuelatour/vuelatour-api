// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { DineroReportService } from './dinero-report.service';
import { AircraftBalanceService } from '../aircraft/aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceHojaOtrosMovimientosPayload,
  DineroOtroIngresoFilaPayload,
  DineroXlsxPayload,
} from '../pyservices/pyservices.service';
import {
  NOTA_PAGO_VENDEDOR_REAL,
  NOTA_PAGO_VENDEDOR_SIN_LINEA,
  NOTA_PROVISION_PAGO_VENDEDOR,
} from '../../common/pago-vendedor.util';
import {
  AV,
  DESDE,
  GOLDEN_DINERO,
  HASTA,
  V2,
  fakeSupabase,
  gastoComision,
  mundoCon,
  vuelo2,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';

/**
 * COMISIÓN DEL VENDEDOR COMO GASTO — Libro Dinero, hoja «Otros ingresos» y
 * utilidades (pedido del cliente, 28-sep-2026; invariante 31).
 *
 * Por vuelo se resta la PROVISIÓN (sin gasto) **o** lo PAGADO (con gasto),
 * jamás ambos. La provisión se REEMPLAZA entera por lo pagado: exacto ⇒
 * utilidad igual; parcial ⇒ +el faltante; excedido ⇒ −el excedente. Sin
 * gastos de la categoría el payload es el de siempre salvo la NOTA de la
 * provisión (la vieja afirmaba que la categoría no existe).
 */

async function libroDinero(mundo: Record<string, Fila[]>) {
  const f = fakeSupabase(mundo);
  const service = new DineroReportService(
    f.supabase as unknown as SupabaseService,
    {} as never,
  );
  const p = await (
    service as unknown as {
      buildPayload: (a: string, b: string) => Promise<DineroXlsxPayload>;
    }
  ).buildPayload(DESDE, HASTA);
  return { ...p, generado: 'FIJO' } as DineroXlsxPayload;
}

async function otrosMovimientos(
  mundo: Record<string, Fila[]>,
): Promise<BalanceHojaOtrosMovimientosPayload> {
  const f = fakeSupabase(mundo);
  const priv = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    {} as never,
  ) as unknown as {
    gastosEmpresaYSueltos: (a: string, b: string) => Promise<unknown>;
    buildOtrosMovimientos: (
      a: string,
      b: string,
      m: Map<string, unknown>,
      e: unknown,
    ) => Promise<BalanceHojaOtrosMovimientosPayload>;
  };
  return priv.buildOtrosMovimientos(
    DESDE,
    HASTA,
    new Map(),
    await priv.gastosEmpresaYSueltos(DESDE, HASTA),
  );
}

const UTIL_GOLDEN = GOLDEN_DINERO.utilidades_otros_ingresos_mxn ?? 0; // 3,000

const filaComision = (
  p: DineroXlsxPayload,
): DineroOtroIngresoFilaPayload | undefined =>
  p.otros_ingresos.find(
    (f) => f.concepto_ingreso === 'comisión vendedor (Vendedor Uno)',
  );

describe('Libro Dinero — pago REAL al vendedor (COMISION_VENDEDOR, 28-sep-2026)', () => {
  it('a) SIN gasto de comisión: payload = golden (solo cambia la NOTA de la provisión) y SIN la clave nueva', async () => {
    const p = await libroDinero(mundoCon());
    expect(JSON.stringify(p)).toBe(JSON.stringify(GOLDEN_DINERO));
    expect(p).not.toHaveProperty('utilidades_comision_vendedor_pagada_mxn');
    const f = filaComision(p)!;
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · provisión',
    );
    expect(f.nota_egreso).toBe(NOTA_PROVISION_PAGO_VENDEDOR);
    // El texto nuevo ya no miente: enseña el camino correcto.
    expect(NOTA_PROVISION_PAGO_VENDEDOR).not.toContain(
      'no existe categoría de gasto',
    );
    expect(NOTA_PROVISION_PAGO_VENDEDOR).toContain('«Comisión del vendedor»');
  });

  it('b) pago EXACTO de $1,600 ⇒ «gasto real», provisionada 0, pagada 1,600, utilidades == golden', async () => {
    const p = await libroDinero(
      mundoCon({ gastos: [gastoComision('g-cv', 1600)] }),
    );
    const f = filaComision(p)!;
    expect(f).toEqual({
      clave: 'vtleticia',
      fecha_vuelo: '2026-09-10T15:00:00+00:00',
      concepto_egreso: 'pago comisión vendedor (Vendedor Uno) · gasto real',
      egreso_mxn: 1600,
      fecha_egreso: '2026-09-10',
      nota_egreso: NOTA_PAGO_VENDEDOR_REAL,
      concepto_ingreso: 'comisión vendedor (Vendedor Uno)',
      ingreso_mxn: 1600,
      fecha_ingreso: '2026-09-10T15:00:00+00:00',
      remanente_mxn: 0,
      factura: null,
    });
    expect(p.utilidades_comision_vendedor_provisionada_mxn).toBe(0);
    expect(p.utilidades_comision_vendedor_pagada_mxn).toBe(1600);
    expect(p.utilidades_otros_ingresos_mxn).toBe(UTIL_GOLDEN);
    // Sin fila extra: la provisión se REEMPLAZÓ, no se agregó otra.
    expect(p.otros_ingresos).toHaveLength(GOLDEN_DINERO.otros_ingresos.length);
  });

  it('c) PARCIAL $1,200 ⇒ «faltan $400.00 MXN» y utilidades = golden + 400 (nunca provisión del faltante)', async () => {
    const p = await libroDinero(
      mundoCon({ gastos: [gastoComision('g-cv', 1200)] }),
    );
    const f = filaComision(p)!;
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real · parcial: faltan $400.00 MXN',
    );
    expect(f.egreso_mxn).toBe(1200);
    expect(f.remanente_mxn).toBe(400);
    expect(p.utilidades_comision_vendedor_provisionada_mxn).toBe(0);
    expect(p.utilidades_comision_vendedor_pagada_mxn).toBe(1200);
    expect(p.utilidades_otros_ingresos_mxn).toBe(UTIL_GOLDEN + 400);
  });

  it('d) EXCEDIDO $2,000 ⇒ «excede $400.00 MXN» y utilidades = golden − 400', async () => {
    const p = await libroDinero(
      mundoCon({ gastos: [gastoComision('g-cv', 2000)] }),
    );
    expect(filaComision(p)!.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real · excede $400.00 MXN',
    );
    expect(filaComision(p)!.remanente_mxn).toBe(-400);
    expect(p.utilidades_otros_ingresos_mxn).toBe(UTIL_GOLDEN - 400);
  });

  it('e) vuelo SIN comisión cobrada con gasto de $500 ⇒ solo-egreso con su nota y utilidades = golden − 500', async () => {
    const p = await libroDinero(
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
    // La provisión del #501 sigue viva (su vuelo no tiene gasto real).
    expect(filaComision(p)!.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · provisión',
    );
    const solo = p.otros_ingresos.find((f) =>
      (f.concepto_egreso ?? '').startsWith('pago comisión vendedor ·'),
    );
    expect(solo).toEqual({
      clave: 'vtleticia',
      fecha_vuelo: '2026-09-20T15:00:00+00:00',
      concepto_egreso:
        'pago comisión vendedor · sin comisión cobrada en la cotización',
      egreso_mxn: 500,
      fecha_egreso: '2026-09-10',
      nota_egreso: NOTA_PAGO_VENDEDOR_SIN_LINEA,
      concepto_ingreso: null,
      ingreso_mxn: null,
      fecha_ingreso: null,
      remanente_mxn: -500,
      factura: null,
    });
    expect(p.utilidades_comision_vendedor_provisionada_mxn).toBe(1600);
    expect(p.utilidades_comision_vendedor_pagada_mxn).toBe(500);
    expect(p.utilidades_otros_ingresos_mxn).toBe(UTIL_GOLDEN - 500);
  });

  it('f) la comisión NO entra a «otros gastos» (hoja 3) ni a su acumulado, ni se acredita a ningún avión', async () => {
    const p = await libroDinero(
      mundoCon({ gastos: [gastoComision('g-cv', 1600)] }),
    );
    expect(p.otros_gastos).toEqual(GOLDEN_DINERO.otros_gastos);
    expect(p.utilidades_otros_gastos_mxn).toBe(
      GOLDEN_DINERO.utilidades_otros_gastos_mxn,
    );
    expect(p.utilidades_aviones).toEqual(GOLDEN_DINERO.utilidades_aviones);
    expect(p.vuelos).toEqual(GOLDEN_DINERO.vuelos);
    expect(p.combustible).toEqual(GOLDEN_DINERO.combustible);
  });

  it('g) 80 USD SIN tc_gasto ⇒ T.C. de VENTA del vuelo (misma regla que su TUA pagado) ⇒ 1,600.00 exacto', async () => {
    const p = await libroDinero(
      mundoCon({
        v2: vuelo2(), // K 18: el Libro NO usa promedio del periodo
        gastos: [gastoComision('g-cv', 80, { moneda: 'USD', tc_gasto: null })],
      }),
    );
    expect(filaComision(p)!.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real',
    );
    expect(filaComision(p)!.egreso_mxn).toBe(1600);
  });

  it('g2) USD sin NINGÚN T.C. ⇒ egreso vacío con «(USD sin TC)», no suma en falso', async () => {
    const p = await libroDinero(
      mundoCon({
        v1: { tc_usd_mxn: null, monto_total_mxn: null },
        gastos: [gastoComision('g-cv', 80, { moneda: 'USD', tc_gasto: null })],
      }),
    );
    const f = p.otros_ingresos.find((x) =>
      (x.concepto_egreso ?? '').startsWith('pago comisión vendedor'),
    )!;
    expect(f.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real (USD sin TC)',
    );
    expect(f.egreso_mxn).toBeNull();
    expect(p.utilidades_comision_vendedor_pagada_mxn).toBe(0);
  });

  it('h) partición INCONSISTENTE con comisión cotizada ⇒ el MISMO concepto de solo-egreso en los DOS libros', async () => {
    const mundo = mundoCon({
      v1: {
        calculo_snapshot: {
          desglose: [
            { clave: 'TIEMPO_VUELO', concepto: 'Vuelo', monto_usd: 2000 },
            { clave: 'COMISION_VENDEDOR', concepto: 'Comisión', monto_usd: 80 },
          ],
        },
        monto_total_usd: 9999,
      },
      gastos: [gastoComision('g-cv', 1600)],
    });
    const concepto =
      'pago comisión vendedor (Vendedor Uno) · desglose de la cotización inconsistente: sin apareo';
    const p = await libroDinero(mundo);
    const f = p.otros_ingresos.find((x) => x.concepto_egreso === concepto);
    expect(f).toBeDefined();
    expect(f!.egreso_mxn).toBe(1600);
    expect(f!.nota_egreso).toBe(NOTA_PAGO_VENDEDOR_SIN_LINEA);
    const om = await otrosMovimientos(mundo);
    const fila = om.filas.find((x) => x.clave.endsWith('501'))!;
    expect(`${fila.concepto_egreso}\n${fila.nota_egreso ?? ''}`).toContain(
      concepto,
    );
  });

  it('los DOS libros dicen lo MISMO del pago real (concepto y monto del egreso del vendedor)', async () => {
    for (const monto of [1600, 1200, 2000]) {
      const mundo = mundoCon({ gastos: [gastoComision('g-cv', monto)] });
      const libro = filaComision(await libroDinero(mundo))!;
      const om = await otrosMovimientos(mundo);
      const nota = om.filas.find((x) => x.clave.endsWith('501'))!.nota_egreso;
      const linea = (nota ?? '')
        .split('\n')
        .find((l) => l.startsWith('pago comisión vendedor'));
      expect(linea).toBe(
        `${libro.concepto_egreso} = $${monto.toLocaleString('es-MX', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
      );
    }
  });
});
