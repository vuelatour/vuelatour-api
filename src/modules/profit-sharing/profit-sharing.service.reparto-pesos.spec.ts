// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  fuenteTcLegible: (f: string | null | undefined) =>
    f === 'OPEN_ER_API' ? 'open.er-api' : (f ?? 'TC oficial'),
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));
// Sin la migración del cierre de mes (el eje de siempre): el mundo de los
// libros no trae `fecha_contable`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

import * as fs from 'fs';
import * as path from 'path';
import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  AV,
  DESDE,
  HASTA,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';
import {
  AV2,
  ING_PESOS,
  TC_OFICIAL_PESOS,
  V3,
  fakeSupabaseReparto,
  mundoPesos,
  sinLlavesPesos,
  sinLlavesPesosPayload,
} from './reparto-pesos.fixture-spec';

/**
 * REPARTO A SOCIOS EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92).
 * Pedido del cliente: «debe venir todo en pesos porque casi siempre se les
 * transfiere a los socios en pesos mexicanos». PESOS REALES: la MISMA
 * cascada calculada en MXN —venta del avión × el K de su vuelo (T.C. de la
 * cotización ?? oficial del día de la cotización: el del balance),
 * comisiones con la fuente única del balance, gastos MXN tal cual, USD × su
 * T.C. o el oficial de su día, reserva × el oficial del cierre, otros
 * ingresos con su neto en pesos— y el reparto por residuo mayor sobre el
 * saldo en pesos. Todo `*_mxn` es ADITIVO: sin ellos la respuesta y el
 * payload salen BYTE A BYTE como en el golden. HISTORIA: el golden del
 * 0.0.94 era el del 0.0.93 (los dólares no se movían). El 20-oct-2026
 * (invariante 99, LA CASCADA DEL BALANCE) los dólares cambiaron A PROPÓSITO
 * —la reserva de overhaul ya no resta del saldo, la provisión AFAC sí, la
 * categoría INDIRECTO cuenta— y el golden se volvió a capturar con ese
 * código: `libros-pesos.golden-0101.json` (4,488.80 de saldo en XB-TST =
 * 4,348.80 + 140 de reserva que ya no resta). El 23-oct-2026 (invariante
 * 104, COMBUSTIBLE APARTE) el GAS salió de «directos» a su propia línea
 * (`combustible_*`, grupo COMBUSTIBLE) y nació `utilidad_antes_gastos_*`;
 * el golden se volvió a capturar: `libros-pesos.golden-0103.json` (mismo
 * saldo; directos 367.60 ⇒ 200 + combustible 167.60; el spec
 * `…combustible.spec` prueba esa identidad contra el 0101). El 6-nov-2026
 * (invariante 121, LA RESERVA SE DESCUENTA A TODOS LOS SOCIOS) los dólares
 * de cada socio cambiaron A PROPÓSITO —`reparto[].monto_usd` = utilidad −
 * su reserva, `descuenta_reserva: true`, `reserva_retenida_usd` = toda la
 * reserva; el saldo del avión NO cambia— y el golden se volvió a capturar:
 * `libros-pesos.golden-0125.json`. Recaptura (SOLO a propósito):
 * `ACTUALIZAR_GOLDEN=1 npx jest <este archivo>` escribe `GOLDEN_ARCHIVO`
 * con el código actual; luego se documenta aquí por qué cambió.
 */

// 7-nov-2026 (API 0.0.128, invariante 124): `saldo_a_repartir_*` (saldo −
// reserva) en cada avión y en el payload ⇒ golden 0128. 9-nov-2026 (API
// 0.0.129, invariante 125, LA RESERVA RESTA EN LA CASCADA, ANTES DEL TOTAL):
// el saldo pasa a ser el que era el saldo a repartir, nace
// `reserva_overhaul_en_cascada` y `saldo_a_repartir_*` se retira ⇒ golden
// recapturado como 0129 (el 0128 se queda para el spec de identidad).
const GOLDEN_ARCHIVO = 'libros-pesos.golden-0129.json';
// Sin el archivo (primera recaptura con ACTUALIZAR_GOLDEN) el spec carga y
// los tests del golden fallan solos.
const GOLDEN = (
  fs.existsSync(path.join(__dirname, GOLDEN_ARCHIVO))
    ? JSON.parse(fs.readFileSync(path.join(__dirname, GOLDEN_ARCHIVO), 'utf8'))
    : {}
) as Record<string, unknown>;

const r2 = (x: number) => Math.round(x * 100) / 100;

function servicio(
  m: Record<string, Fila[]>,
  mapa: Record<string, number> | null,
) {
  const f = fakeSupabaseReparto(m);
  const dias: string[] = [];
  const svc = new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    {
      oficialDetallePara: (dia: string) => {
        dias.push(dia);
        const tc = mapa?.[dia];
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    {} as never,
  );
  svc.ahora = () => new Date('2026-10-19T15:00:00Z');
  return { svc, dias };
}

const Q = { desde: DESDE, hasta: HASTA };

async function compute(
  m: Record<string, Fila[]> = mundoPesos(),
  mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
) {
  return servicio(m, mapa).svc.compute(Q);
}

type Payload = {
  reparto_en_pesos?: true;
  aviones: Array<Record<string, unknown>>;
};

async function payload(
  m: Record<string, Fila[]> = mundoPesos(),
  mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
): Promise<Payload> {
  const { svc } = servicio(m, mapa);
  const r = await (
    svc as unknown as {
      buildRepartoPayload: (q: typeof Q) => Promise<{ payload: Payload }>;
    }
  ).buildRepartoPayload(Q);
  return r.payload;
}

type Resultado = Awaited<ReturnType<typeof compute>>;
const avion = (r: Resultado, id: string) => {
  const a = r.aviones.find((x) => x.aeronave.id === id);
  if (!a) throw new Error(`sin avión ${id}`);
  return a;
};

if (process.env.ACTUALIZAR_GOLDEN) {
  it('ACTUALIZAR_GOLDEN: recaptura el golden con el código actual (solo a propósito)', async () => {
    const nuevo = {
      reparto_oficial: sinLlavesPesos(await compute()),
      reparto_sin_oficial: sinLlavesPesos(await compute(mundoPesos(), null)),
      reparto_vacio: sinLlavesPesos(
        await compute({ ...mundoPesos(), aeronave: [] }),
      ),
      payload_oficial: sinLlavesPesosPayload(await payload()),
    };
    fs.writeFileSync(
      path.join(__dirname, GOLDEN_ARCHIVO),
      `${JSON.stringify(nuevo, null, 2)}\n`,
    );
  });
}

describe('Reparto a socios EN PESOS (invariante 92) — los dólares de siempre', () => {
  it('GOLDEN: sin las llaves en pesos, la respuesta es BYTE A BYTE la del golden 0.0.128 (con oficial, sin oficial y vacía)', async () => {
    expect(JSON.stringify(sinLlavesPesos(await compute()))).toBe(
      JSON.stringify(GOLDEN.reparto_oficial),
    );
    expect(
      JSON.stringify(sinLlavesPesos(await compute(mundoPesos(), null))),
    ).toBe(JSON.stringify(GOLDEN.reparto_sin_oficial));
    expect(
      JSON.stringify(
        sinLlavesPesos(await compute({ ...mundoPesos(), aeronave: [] })),
      ),
    ).toBe(JSON.stringify(GOLDEN.reparto_vacio));
  });

  it('GOLDEN: el payload del PDF/XLSX sin las llaves en pesos es BYTE A BYTE el del golden 0.0.129', async () => {
    expect(JSON.stringify(sinLlavesPesosPayload(await payload()))).toBe(
      JSON.stringify(GOLDEN.payload_oficial),
    );
  });

  // LA RESERVA RESTA EN LA CASCADA (9-nov-2026, API 0.0.129, invariante
  // 125): frente al 7-nov-2026 lo ÚNICO que cambia es que el saldo pasa a
  // ser el que entonces era `saldo_a_repartir_*` (saldo − reserva), nace la
  // bandera `reserva_overhaul_en_cascada` y `saldo_a_repartir_*` se retira;
  // ningún otro número ni llave se movió (los montos por socio, tampoco).
  it('IDENTIDAD con el golden 0.0.128: el saldo de hoy es el «saldo a repartir» de entonces y todo lo demás es BYTE A BYTE', async () => {
    const g0128 = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, 'libros-pesos.golden-0128.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    // El golden 0128 reescrito como lo manda el 0.0.129.
    const como0129 = (r: unknown): unknown => {
      const c = r as { aviones?: Array<Record<string, unknown>> };
      for (const a of c.aviones ?? []) {
        if ('saldo_disponible_usd' in a)
          a.saldo_disponible_usd = a.saldo_a_repartir_usd;
        if ('saldo_usd' in a) a.saldo_usd = a.saldo_a_repartir_usd;
        delete a.saldo_a_repartir_usd;
        delete a.saldo_a_repartir_mxn;
      }
      return c;
    };
    const sinBandera = (r: unknown): unknown => {
      const c = r as { aviones?: Array<Record<string, unknown>> };
      for (const a of c.aviones ?? []) delete a.reserva_overhaul_en_cascada;
      return c;
    };
    expect(JSON.stringify(sinBandera(sinLlavesPesos(await compute())))).toBe(
      JSON.stringify(como0129(g0128.reparto_oficial)),
    );
    expect(
      JSON.stringify(
        sinBandera(sinLlavesPesos(await compute(mundoPesos(), null))),
      ),
    ).toBe(JSON.stringify(como0129(g0128.reparto_sin_oficial)));
    expect(
      JSON.stringify(sinBandera(sinLlavesPesosPayload(await payload()))),
    ).toBe(JSON.stringify(como0129(g0128.payload_oficial)));
  });

  it('la respuesta lleva `reparto_en_pesos: true` en la raíz, también VACÍA (sin aviones activos)', async () => {
    expect((await compute()).reparto_en_pesos).toBe(true);
    const vacia = await compute({ ...mundoPesos(), aeronave: [] });
    expect(vacia.aviones).toEqual([]);
    expect(vacia.reparto_en_pesos).toBe(true);
  });
});

describe('Reparto a socios EN PESOS — la cascada en pesos reales', () => {
  it('XB-TST con oficiales: venta × K de cada vuelo, comisiones del balance, gastos en pesos, reserva × oficial del cierre, otros ingresos y saldo', async () => {
    const a = avion(await compute(), AV);
    // Venta del avión cobrada: #501 1,793.72 × 20 (capturado) + #502 1,000 ×
    // 18.25 (oficial del día de la COTIZACIÓN, 14-sep).
    expect(a.ingresos.cobrado_mxn).toBe(r2(1793.72 * 20 + 1000 * 18.25));
    expect(a.ingresos.pendiente_cobro_mxn).toBe(r2(206.28 * 20 + 500 * 18.25));
    // Comisiones: #501 350 MXN × 2000/2230 = 313.90 (la de siempre); #502 la
    // comisión bancaria de 30 USD con el K del balance (18.25) = 547.50.
    expect(a.ingresos.comisiones_venta_mxn).toBe(861.4);
    // Gastos: OPERACIONES 200 USD × 19.5; el GAS 3,000 MXN va APARTE
    // (combustible, 23-oct-2026, invariante 104); REFACCION 100 USD × 18.4
    // (oficial de SU día); PERMISO 500 MXN tal cual.
    expect(a.gastos.directos_mxn).toBe(3900);
    expect(a.gastos.combustible_mxn).toBe(3000);
    expect(a.gastos.indirectos_mxn).toBe(1840);
    expect(a.gastos.permisos_mxn).toBe(500);
    // Pool de FIJOS: (7,000 MXN + 300 USD × 17.9) ÷ 2 aviones activos.
    expect(a.gastos.otros_prorrateados_mxn).toBe(6185);
    // Reserva: 3.5 h × 40 USD = 140 USD × 18.6 (oficial del 30-sep, cierre).
    expect(a.reserva_overhaul_mxn).toBe(2604);
    expect(a.detalle.reserva).toMatchObject({
      monto_usd: 140,
      monto_mxn: 2604,
      tc: 18.6,
    });
    expect(a.ingresos.otros_ingresos_avion_mxn).toBe(46550.8);
    // Sin tarifa AFAC en la ficha del avión: provisión 0 (invariante 99).
    expect(a.afac_reservado_mxn).toBe(0);
    expect(a.afac_reservado_usd).toBe(0);
    // Saldo = cobrado − comisiones − directos − indirectos − permisos −
    // otros − provisión AFAC − RESERVA DE OVERHAUL + otros ingresos, todo en
    // pesos (la reserva resta EN la cascada, 9-nov-2026, invariante 125).
    const saldo = r2(
      a.ingresos.cobrado_mxn -
        a.ingresos.comisiones_venta_mxn -
        a.gastos.directos_mxn -
        a.gastos.combustible_mxn -
        a.gastos.indirectos_mxn -
        a.gastos.permisos_mxn -
        a.gastos.otros_prorrateados_mxn -
        a.afac_reservado_mxn -
        a.reserva_overhaul_mxn +
        a.ingresos.otros_ingresos_avion_mxn,
    );
    expect(a.saldo_disponible_mxn).toBe(saldo);
    // 81,784.80: los 84,388.80 de antes de la reserva − 2,604 de reserva.
    expect(a.saldo_disponible_mxn).toBe(81784.8);
    expect(a.pesos_sin_tc_usd).toBe(0);
  });

  it('detalle por vuelo: parte del avión cobrada / pendiente en pesos y el K usado', async () => {
    const a = avion(await compute(), AV);
    const porFolio = new Map(a.detalle.vuelos.map((v) => [v.folio, v]));
    expect(porFolio.get(501)).toMatchObject({
      cobrado_avion_usd: 1793.72,
      cobrado_avion_mxn: 35874.4,
      pendiente_avion_mxn: 4125.6,
      tc_pesos: 20,
    });
    expect(porFolio.get(502)).toMatchObject({
      cobrado_avion_usd: 1000,
      cobrado_avion_mxn: 18250,
      pendiente_avion_mxn: 9125,
      tc_pesos: 18.25,
    });
    // Σ del detalle == agregado.
    expect(
      r2(a.detalle.vuelos.reduce((s, v) => s + (v.cobrado_avion_mxn ?? 0), 0)),
    ).toBe(a.ingresos.cobrado_mxn);
  });

  it('el K de los pesos NO mueve dólares: el #502 (sin T.C., cobros en USD) no pide el oficial para sus dólares y su comisión en USD es la de siempre', async () => {
    const r = await compute();
    const a = avion(r, AV);
    // El oficial del #502 solo vive en los pesos: los conteos y el detalle
    // del T.C. oficial de los DÓLARES no lo cuentan.
    expect(r.tc_oficial.vuelos).toBe(0);
    const v502 = a.detalle.vuelos.find((v) => v.id === V3)!;
    expect(v502.tc_oficial).toBeUndefined();
    expect(v502.comisiones_avion_usd).toBe(30);
    expect(a.ingresos.comisiones_venta_usd).toBe(45.7);
  });

  it('gastos por categoría en pesos (MXN tal cual, USD × su T.C.; la fila EXCLUIDA también trae sus pesos)', async () => {
    const a = avion(await compute(), AV);
    const mxn = Object.fromEntries(
      a.detalle.gastos_por_categoria.map((g) => [g.categoria, g.mxn]),
    );
    expect(mxn).toEqual({
      OPERACIONES: 3900,
      GAS: 3000,
      REFACCION: 1840,
      'TUAS (egreso VuelaTour — Otros movimientos)': 1500,
      PERMISO: 500,
    });
    expect(Object.keys(a.detalle.gastos_por_categoria[0])).toEqual([
      'categoria',
      'etiqueta',
      'grupo',
      'count',
      'usd',
      'mxn',
      'sin_tc_count',
      'sin_tc_mxn',
      'tc_oficial_count',
      'tc_oficial_mxn',
    ]);
  });

  it('avión SIN vuelos (XB-DOS): solo su parte del pool en pesos; saldo y reparto negativos al centavo', async () => {
    const d = avion(await compute(), AV2);
    expect(d.ingresos.cobrado_mxn).toBe(0);
    expect(d.ingresos.comisiones_venta_mxn).toBe(0);
    expect(d.gastos.otros_prorrateados_mxn).toBe(6185);
    expect(d.reserva_overhaul_mxn).toBe(0);
    expect(d.detalle.reserva.tc).toBe(18.6);
    expect(d.saldo_disponible_mxn).toBe(-6185);
    expect(d.reparto).toEqual([
      {
        socio_id: 'u-mau',
        socio_nombre: 'Mauricio Roque',
        porcentaje: 100,
        monto_usd: -350,
        monto_mxn: -6185,
        // Invariante 99: su parte antes de la reserva y su reserva (0: XB-DOS
        // no tiene tarifa ni horas); se le descuenta como a todos (invariante
        // 121), pero 0 no mueve nada.
        utilidad_usd: -350,
        utilidad_mxn: -6185,
        reserva_usd: 0,
        reserva_mxn: 0,
        descuenta_reserva: true,
      },
    ]);
    expect(d.pesos_sin_tc_usd).toBe(0);
  });
});

describe('Reparto a socios EN PESOS — reparto por residuo mayor', () => {
  it('40.92 / 59.08 sobre el saldo en pesos ANTES de la reserva: Σ de lo que reciben == saldo (ya neto) al centavo y el centavo del residuo cae en el residuo mayor', async () => {
    const a = avion(await compute(), AV);
    // Utilidad: 8,438,880 ¢ × 0.4092 = 3,453,189.696 ⇒ piso 3,453,189 + el
    // centavo que falta (residuo mayor) = 34,531.90; × 0.5908 = 4,985,690.304
    // ⇒ 49,856.90. Reserva 2,604 MXN repartida igual: 1,065.56 / 1,538.44, y
    // se le descuenta a los dos (invariante 121): 33,466.34 / 48,318.46.
    expect(
      a.reparto.map((x) => [x.porcentaje, x.utilidad_mxn, x.monto_mxn]),
    ).toEqual([
      [40.92, 34531.9, 33466.34],
      [59.08, 49856.9, 48318.46],
    ]);
    expect(a.reserva_retenida_mxn).toBe(2604);
    expect(r2(a.reparto.reduce((s, x) => s + x.monto_mxn, 0))).toBe(
      a.saldo_disponible_mxn,
    );
  });

  it('tres socios a 33.333 / 33.333 / 33.334 en varios saldos: Σ de lo que reciben == saldo (ya neto) SIEMPRE (en pesos y en dólares)', async () => {
    for (const fijo of [7000, 7000.01, 12345.67, 99999.99]) {
      const m = mundoPesos();
      m.gasto = m.gasto.map((g) =>
        g.id === 'g-fijo' ? { ...g, monto: fijo } : g,
      );
      m.aeronave_socio = [
        ...m.aeronave_socio.filter((s) => s.aeronave_id !== AV2),
        ...['u-a', 'u-b', 'u-c'].map((id, i) => ({
          aeronave_id: AV2,
          socio_id: id,
          porcentaje: i === 2 ? '33.334' : '33.333',
          vigente_desde: '2020-01-01',
          vigente_hasta: null,
        })),
      ];
      for (const a of (await compute(m)).aviones) {
        // Lo que reciben = el saldo (ya neto de la reserva, invariante 125),
        // al centavo; + lo que VuelaTour retiene = el saldo antes de ella.
        expect(r2(a.reparto.reduce((s, x) => s + x.monto_mxn, 0))).toBe(
          a.saldo_disponible_mxn,
        );
        expect(r2(a.reparto.reduce((s, x) => s + x.monto_usd, 0))).toBe(
          a.saldo_disponible_usd,
        );
        expect(r2(a.reparto.reduce((s, x) => s + x.utilidad_usd, 0))).toBe(
          r2(a.saldo_disponible_usd + a.reserva_retenida_usd),
        );
      }
    }
  });
});

describe('Reparto a socios EN PESOS — sin T.C.: lo que no llega a pesos se avisa', () => {
  it('sin ningún oficial: el GAS MXN sin T.C. y el ingreso MXN SÍ cuentan en pesos; los dólares sin T.C. van a `pesos_sin_tc_usd`', async () => {
    const r = await compute(mundoPesos(), null);
    const a = avion(r, AV);
    // #502 sin K: ni su venta ni su comisión llegan a pesos.
    const v502 = a.detalle.vuelos.find((v) => v.id === V3)!;
    expect(v502).toMatchObject({
      cobrado_avion_mxn: null,
      pendiente_avion_mxn: null,
      tc_pesos: null,
    });
    expect(a.ingresos.cobrado_mxn).toBe(35874.4);
    expect(a.ingresos.comisiones_venta_mxn).toBe(313.9);
    // El GAS 3,000 MXN sin T.C. no llega a dólares, pero sus pesos son
    // reales: SÍ resta en pesos (como combustible, aparte de los directos).
    expect(a.gastos.gastos_sin_tc_mxn).toBe(4500);
    expect(a.gastos.directos_mxn).toBe(3900);
    expect(a.gastos.combustible_mxn).toBe(3000);
    // REFACCION 100 USD sin T.C. ni oficial: no llega a pesos.
    expect(a.gastos.indirectos_mxn).toBe(0);
    // Pool: 7,000 MXN ÷ 2 (el FIJO de 300 USD no llega a pesos).
    expect(a.gastos.otros_prorrateados_mxn).toBe(3500);
    // Reserva sin oficial del cierre.
    expect(a.reserva_overhaul_mxn).toBe(0);
    expect(a.detalle.reserva.tc).toBeNull();
    // ING-14 en pesos sin T.C.: fuera de los dólares, dentro de los pesos.
    expect(a.ingresos.otros_ingresos_avion_usd).toBe(0);
    expect(a.ingresos.otros_ingresos_avion_mxn).toBe(46550.8);
    expect(a.detalle.otros_ingresos_avion[0]).toMatchObject({
      usd: null,
      mxn: 46550.8,
    });
    // Dólares que entraron al saldo USD sin llegar a pesos: venta del #502
    // (1,000) + su comisión bancaria (30) + REFACCION (100) + su parte del
    // FIJO USD (150) = 1,280. La reserva (140) no entra al saldo (invariante
    // 99) pero sí se le descuenta a cada socio (invariante 121): sin oficial
    // del cierre no tiene pesos y deja incompleta la parte de los dos.
    expect(a.pesos_sin_tc_usd).toBe(1420);
    expect(avion(r, AV2).pesos_sin_tc_usd).toBe(150);
    expect(a.saldo_disponible_mxn).toBe(
      r2(35874.4 - 313.9 - 6900 - 0 - 500 - 3500 - 0 + 46550.8),
    );
  });

  it('un gasto USD con `tc_gasto` NO pide el oficial de su día; uno sin él sí (en el MISMO lote)', async () => {
    const { svc, dias } = servicio(mundoPesos(), TC_OFICIAL_PESOS);
    await svc.compute(Q);
    expect(dias).toContain('2026-09-20');
    expect(dias.filter((d) => d === '2026-09-20')).toHaveLength(1);
    // La reserva pide el oficial del cierre: min(hasta, hoy Cancún).
    expect(dias).toContain('2026-09-30');
  });

  it('cobros MXN sin ningún T.C. quedan FUERA de los pesos (como de los dólares)', async () => {
    const m = mundoPesos();
    m.vuelo = m.vuelo.map((v) =>
      v.id === V3 ? v : { ...v, tc_usd_mxn: null },
    );
    m.cobro_vuelo = m.cobro_vuelo.map((c) =>
      c.id === 'c-1' ? { ...c, tc_usd_mxn: null } : c,
    );
    const a = avion(await compute(m, null), AV);
    expect(a.ingresos.cobros_sin_tc_mxn).toBe(20000);
    const v501 = a.detalle.vuelos.find((v) => v.folio === 501)!;
    expect(v501.tc_pesos).toBeNull();
    expect(v501.cobrado_avion_mxn).toBeNull();
    // Los 1,000 USD que sí entraron (cobro USD, parte del avión) se avisan.
    expect(a.pesos_sin_tc_usd).toBeGreaterThanOrEqual(v501.cobrado_avion_usd);
  });

  it('ingreso en DÓLARES con su T.C. propio: el neto en pesos de la fila del libro (`filaLibroDeIngreso`)', async () => {
    const ingUsd: Fila = {
      ...ING_PESOS,
      categoria: 'VENTA_ACTIVO',
      moneda: 'USD',
      monto: 1000,
      comision_monto: 30,
      tc_usd_mxn: 18.5,
    };
    const a = avion(await compute(mundoPesos({ ingresos: [ingUsd] })), AV);
    expect(a.ingresos.otros_ingresos_avion_usd).toBe(970);
    // 1,000 × 18.5 − 30 × 18.5.
    expect(a.ingresos.otros_ingresos_avion_mxn).toBe(17945);
    expect(a.detalle.otros_ingresos_avion[0]).toMatchObject({
      usd: 970,
      mxn: 17945,
    });
  });
});

describe('Reparto a socios EN PESOS — payload del PDF/XLSX (§2b, pyservices 16d6e2f)', () => {
  /** Las llaves de `RepartoAvion` de pyservices 16d6e2f (reparto en pesos). */
  const LLAVES_AVION_PESOS = [
    'ingresos_cobrado_mxn',
    'comisiones_venta_mxn',
    'pendiente_cobro_mxn',
    'gastos_directos_mxn',
    'gastos_indirectos_mxn',
    'permisos_mxn',
    'otros_mxn',
    'reserva_overhaul_mxn',
    'otros_ingresos_avion_mxn',
    'saldo_mxn',
    'pesos_sin_tc_usd',
    'reserva_tc',
    // Combustible aparte (23-oct-2026, invariante 104).
    'combustible_mxn',
    'utilidad_antes_gastos_mxn',
  ];

  it('bandera raíz y, por avión, las llaves de pyservices con los MISMOS números de la pantalla (el saldo viaja como `saldo_mxn`)', async () => {
    const p = await payload();
    expect(p.reparto_en_pesos).toBe(true);
    const r = await compute();
    for (const a of r.aviones) {
      const pa = p.aviones.find((x) => x.matricula === a.aeronave.matricula)!;
      for (const k of LLAVES_AVION_PESOS) expect(k in pa).toBe(true);
      expect(pa).toMatchObject({
        ingresos_cobrado_mxn: a.ingresos.cobrado_mxn,
        comisiones_venta_mxn: a.ingresos.comisiones_venta_mxn,
        pendiente_cobro_mxn: a.ingresos.pendiente_cobro_mxn,
        gastos_directos_mxn: a.gastos.directos_mxn,
        combustible_mxn: a.gastos.combustible_mxn,
        utilidad_antes_gastos_mxn: a.utilidad_antes_gastos_mxn,
        gastos_indirectos_mxn: a.gastos.indirectos_mxn,
        permisos_mxn: a.gastos.permisos_mxn,
        otros_mxn: a.gastos.otros_prorrateados_mxn,
        reserva_overhaul_mxn: a.reserva_overhaul_mxn,
        otros_ingresos_avion_mxn: a.ingresos.otros_ingresos_avion_mxn,
        saldo_mxn: a.saldo_disponible_mxn,
        pesos_sin_tc_usd: a.pesos_sin_tc_usd,
        reserva_tc: a.detalle.reserva.tc,
      });
      expect(
        (pa.reparto as Array<Record<string, unknown>>).map((x) => x.monto_mxn),
      ).toEqual(a.reparto.map((x) => x.monto_mxn));
    }
    // Las llaves del 0.0.75 siguen siendo las ÚLTIMAS del avión.
    const tst = p.aviones.find((x) => x.matricula === 'XB-TST')!;
    expect(Object.keys(tst).slice(-3)).toEqual([
      'otros_ingresos_avion_usd',
      'otros_ingresos_avion_sin_tc_mxn',
      'otros_ingresos_avion',
    ]);
  });

  it('vuelos con `cobrado_mxn`/`pendiente_mxn` (null sin T.C.) y otros ingresos con `mxn`', async () => {
    const tst = (await payload(mundoPesos(), null)).aviones.find(
      (x) => x.matricula === 'XB-TST',
    )!;
    const vuelos = tst.vuelos as Array<Record<string, unknown>>;
    expect(
      vuelos.map((v) => [v.folio, v.cobrado_mxn, v.pendiente_mxn]),
    ).toEqual([
      [501, 35874.4, 4125.6],
      [502, null, null],
    ]);
    expect(tst.otros_ingresos_avion).toEqual([
      expect.objectContaining({ clave: 'ING-14', usd: null, mxn: 46550.8 }),
    ]);
    // 1,280 de siempre + los 140 de la reserva sin oficial que se descuenta
    // a todos los socios (invariante 121).
    expect(tst.pesos_sin_tc_usd).toBe(1420);
    expect(tst.reserva_tc).toBeNull();
  });
});
