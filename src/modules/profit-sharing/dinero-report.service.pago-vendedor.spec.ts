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
import { ETIQUETA_FACTURA_NO_LLEVA } from '../flights/factura-cliente.util';
import { AircraftBalanceService } from '../aircraft/aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceHojaOtrosMovimientosPayload,
  DineroOtroIngresoFilaPayload,
  DineroXlsxPayload,
} from '../pyservices/pyservices.service';
import {
  NOTA_PAGO_VENDEDOR_REAL,
  NOTA_PAGO_VENDEDOR_SIN_LINEA,
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
 * 13-oct-2026 (API 0.0.74, invariante 61; decisión 3 del lote del cliente:
 * «comisión del vendedor SOLO como gasto real»): ya NO existe la provisión.
 * Sin gasto real la fila de comisión conserva el ingreso cobrado y no lleva
 * egreso (remanente = ingreso) y utilidades no resta nada; con gasto real
 * resta lo PAGADO (exacto ⇒ ingreso − pagado = 0; parcial ⇒ +el faltante;
 * excedido ⇒ −el excedente). Este libro NO modela la vigencia de las
 * comisiones a cargo del avión: resta el gasto real entero UNA vez en todo
 * vuelo, aunque en el Balance general, en los vuelos completados de la regla,
 * lo cargue el avión (diferencia ESPERADA, probada abajo).
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

/**
 * Utilidades «otros ingresos» SIN gasto real: 4,600 (TUAs 2,000 + extras
 * 1,000 + comisión cobrada 1,600; hasta el 0.0.73 eran 3,000 porque la
 * provisión de 1,600 restaba). Con un pago real de X: 4,600 − X.
 */
/**
 * El Balance GENERAL completo (`xlsxGeneral`, vigencia default 1-sep-2026):
 * a diferencia de la llamada directa de arriba, su «otros movimientos» recibe
 * las partes que cada avión ya absorbió (invariante 61).
 */
async function balanceGeneral(mundo: Record<string, Fila[]>): Promise<{
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
}> {
  let enviado: unknown = null;
  const service = new AircraftBalanceService(
    fakeSupabase(mundo).supabase as unknown as SupabaseService,
    {
      generateBalanceGeneralXlsx: (p: unknown) => {
        enviado = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  await service.xlsxGeneral(DESDE, HASTA);
  return enviado as {
    consolidado: BalanceAvionPayload;
    aviones: BalanceAvionPayload[];
  };
}

const UTIL_GOLDEN = GOLDEN_DINERO.utilidades_otros_ingresos_mxn ?? 0; // 4,600

const filaComision = (
  p: DineroXlsxPayload,
): DineroOtroIngresoFilaPayload | undefined =>
  p.otros_ingresos.find(
    (f) => f.concepto_ingreso === 'comisión vendedor (Vendedor Uno)',
  );

describe('Libro Dinero — pago REAL al vendedor (COMISION_VENDEDOR, 28-sep-2026)', () => {
  it('a) SIN gasto de comisión: payload = golden, la fila de comisión SIN egreso (remanente = ingreso), provisionada 0, SIN `pagada` y con la bandera nueva', async () => {
    const p = await libroDinero(mundoCon());
    expect(JSON.stringify(p)).toBe(JSON.stringify(GOLDEN_DINERO));
    expect(p).not.toHaveProperty('utilidades_comision_vendedor_pagada_mxn');
    expect(p.comision_vendedor_solo_gasto_real).toBe(true);
    const f = filaComision(p)!;
    // Hasta el 0.0.73: «pago comisión vendedor (Vendedor Uno) · provisión» =
    // 1,600 con la nota de la PROVISIÓN y remanente 0.
    expect([
      f.concepto_egreso,
      f.egreso_mxn,
      f.fecha_egreso,
      f.nota_egreso,
    ]).toEqual([null, null, null, null]);
    expect(f.ingreso_mxn).toBe(1600);
    expect(f.remanente_mxn).toBe(1600);
    expect(p.utilidades_comision_vendedor_provisionada_mxn).toBe(0);
    // TUAs 2,000 + extras 1,000 + comisión cobrada 1,600 (nada la resta).
    expect(p.utilidades_otros_ingresos_mxn).toBe(4600);
    // Ninguna fila habla de provisión.
    expect(
      p.otros_ingresos
        .flatMap((x) => [x.concepto_egreso, x.nota_egreso])
        .filter(Boolean)
        .join('\n'),
    ).not.toMatch(/PROVISI[OÓ]N|provisi[oó]n/);
  });

  it('b) pago EXACTO de $1,600 ⇒ «gasto real», provisionada 0, pagada 1,600, utilidades = golden − 1,600 (nota sin «provisión»)', async () => {
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
      // 13-oct-2026 (invariante 60): el #501 tiene cobros sin cuenta ni
      // método ⇒ «No lleva factura».
      factura: ETIQUETA_FACTURA_NO_LLEVA,
    });
    expect(NOTA_PAGO_VENDEDOR_REAL).not.toMatch(/provisi[oó]n/i);
    expect(p.utilidades_comision_vendedor_provisionada_mxn).toBe(0);
    expect(p.utilidades_comision_vendedor_pagada_mxn).toBe(1600);
    expect(p.utilidades_otros_ingresos_mxn).toBe(UTIL_GOLDEN - 1600);
    // Sin fila extra: el pago va en la MISMA fila de la comisión.
    expect(p.otros_ingresos).toHaveLength(GOLDEN_DINERO.otros_ingresos.length);
    expect(p.comision_vendedor_solo_gasto_real).toBe(true);
  });

  it('c) PARCIAL $1,200 ⇒ «faltan $400.00 MXN» y utilidades = golden − 1,200 (nunca provisión del faltante)', async () => {
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
    // 4,600 − 1,200 = 3,400 (= el 3,000 del 0.0.73 + el faltante de 400).
    expect(p.utilidades_otros_ingresos_mxn).toBe(UTIL_GOLDEN - 1200);
    expect(p.utilidades_otros_ingresos_mxn).toBe(3400);
  });

  it('d) EXCEDIDO $2,000 ⇒ «excede $400.00 MXN» y utilidades = golden − 2,000', async () => {
    const p = await libroDinero(
      mundoCon({ gastos: [gastoComision('g-cv', 2000)] }),
    );
    expect(filaComision(p)!.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real · excede $400.00 MXN',
    );
    expect(filaComision(p)!.remanente_mxn).toBe(-400);
    // 4,600 − 2,000 = 2,600 (= el 3,000 del 0.0.73 − el excedente de 400).
    expect(p.utilidades_otros_ingresos_mxn).toBe(UTIL_GOLDEN - 2000);
    expect(p.utilidades_otros_ingresos_mxn).toBe(2600);
  });

  it('e) vuelo SIN comisión cobrada con gasto de $500 ⇒ solo-egreso con su nota y utilidades = golden − 500; la fila del #501 (sin gasto) ya no trae «· provisión»', async () => {
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
    // El #501 no tiene gasto real: su fila de comisión no lleva egreso
    // (hasta el 0.0.73: «pago comisión vendedor (Vendedor Uno) · provisión»).
    expect(filaComision(p)!.concepto_egreso).toBeNull();
    expect(filaComision(p)!.egreso_mxn).toBeNull();
    expect(filaComision(p)!.remanente_mxn).toBe(1600);
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
    expect(p.utilidades_comision_vendedor_provisionada_mxn).toBe(0);
    expect(p.utilidades_comision_vendedor_pagada_mxn).toBe(500);
    expect(p.utilidades_otros_ingresos_mxn).toBe(UTIL_GOLDEN - 500);
    expect(
      p.otros_ingresos
        .flatMap((x) => [x.concepto_egreso, x.nota_egreso])
        .filter(Boolean)
        .join('\n'),
    ).not.toMatch(/PROVISI[OÓ]N|provisi[oó]n/);
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

  it('FUERA del universo del avión (llamada directa de «otros movimientos», sin partes de los aviones): los DOS libros dicen lo MISMO del pago real (concepto y monto del egreso del vendedor)', async () => {
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
  it('DENTRO de la vigencia (#501 COMPLETADO con comisión cotizada): el Balance general lo trae «a cargo del avión» con egreso $0.00 —el avión lo resta en su columna COMISIONES— y el Libro Dinero egresa el gasto COMPLETO: diferencia ESPERADA (invariante 61; el Dinero no tiene columna por avión), UNA vez dentro de cada libro', async () => {
    const mundo = mundoCon({ gastos: [gastoComision('g-cv', 1600)] });
    const dinero = await libroDinero(mundo);
    const libro = filaComision(dinero)!;
    expect(libro.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real',
    );
    expect(libro.egreso_mxn).toBe(1600);
    expect(dinero.utilidades_comision_vendedor_pagada_mxn).toBe(1600);
    const g = await balanceGeneral(mundo);
    const fila = g.consolidado.otros_movimientos!.filas.find((x) =>
      x.clave.endsWith('501'),
    )!;
    const linea = (fila.nota_egreso ?? '')
      .split('\n')
      .find((l) => l.startsWith('pago comisión vendedor'));
    expect(linea).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real · a cargo del avión XB-TST ($1,600.00 en su columna COMISIONES) = $0.00',
    );
    // El egreso de la fila son solo las TUAS pagadas y la parte VuelaTour de
    // la comisión bancaria: el pago al vendedor no egresa aquí.
    expect(fila.egreso_mxn).toBe(1536.1);
    // Lo carga el avión: su fila trae el pago real en COMISIONES.
    const avion = g.aviones
      .find((a) => a.matricula === 'XB-TST')!
      .vuelos.find((v) => String(v.folio) === '501')!;
    expect(avion.comision_vendedor_real_mxn).toBe(1600);
    expect(avion.comision_vendedor_real_pagos).toBe(1);
    expect(avion.comision_vendedor_prov_mxn).toBe(0);
  });
});
