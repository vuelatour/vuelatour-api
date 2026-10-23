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
// Sin la migración del cierre de mes (el eje de siempre).
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
  gastoBase,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';
import {
  TC_OFICIAL_PESOS,
  fakeSupabaseReparto,
  mundoPesos,
  sinLlavesPesos,
  sinLlavesPesosPayload,
} from './reparto-pesos.fixture-spec';

/**
 * COMBUSTIBLE APARTE DE LOS GASTOS DIRECTOS (23-oct-2026, API 0.0.103,
 * invariante 104). Pedido del cliente con las capturas de la card, de la
 * pantalla por avión y de su Excel «Balance»: «debemos separar gastos
 * directos del combustible, porque los está uniendo, porque no nos está
 * coincidiendo con el excel» (N621TX sep-2026: la card decía «Gastos
 * directos 187,865.72» = combustible 147,277.58 + otros directos 40,588.14,
 * y el Excel tiene las dos líneas por separado).
 *
 * Reglas (sobre el mundo del reparto en pesos, que trae un GAS MXN 3,000 sin
 * T.C. ⇒ 167.60 USD con el oficial de su día, y un OPERACIONES 200 USD a
 * 19.5):
 *  1. El GAS es el grupo COMBUSTIBLE (antes DIRECTO): `gastos.combustible_*`
 *     lo suma y `gastos.directos_*` queda SIN él.
 *  2. «UTILIDAD ANTES DE GASTOS» = cobrado − comisiones − directos − AFAC
 *     (la línea del Excel) y de ahí − combustible − indirectos − permisos −
 *     fijos + otros ingresos = saldo: cuadra al centavo, en USD y en MXN.
 *  3. IDENTIDAD con el golden 0.0.101: directos + combustible = los directos
 *     de antes y NADA más se movió (ni el saldo, ni el reparto, ni el orden
 *     de las llaves): el golden 0101, con el GAS devuelto a DIRECTO, es
 *     BYTE A BYTE la respuesta de hoy.
 *  4. El payload del PDF/XLSX lleva `combustible_*` y
 *     `utilidad_antes_gastos_*` (aditivos) y `gastos_directos_*` sin
 *     combustible; las últimas llaves siguen siendo las del 0.0.75.
 */

const GOLDEN_0101 = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'libros-pesos.golden-0101.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const r2 = (x: number) => Math.round(x * 100) / 100;
const Q = { desde: DESDE, hasta: HASTA };

function servicio(
  m: Record<string, Fila[]>,
  mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
) {
  const f = fakeSupabaseReparto(m);
  const svc = new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    {
      oficialDetallePara: (dia: string) => {
        const tc = mapa?.[dia];
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    {} as never,
  );
  svc.ahora = () => new Date('2026-10-19T15:00:00Z');
  return svc;
}

async function avion(
  m: Record<string, Fila[]>,
  mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
) {
  const r = await servicio(m, mapa).compute(Q);
  const a = r.aviones.find((x) => x.aeronave.id === AV);
  if (!a) throw new Error('sin XB-TST');
  return { r, a };
}

async function payload(m: Record<string, Fila[]> = mundoPesos()) {
  const r = await (
    servicio(m) as unknown as {
      buildRepartoPayload: (
        q: typeof Q,
      ) => Promise<{ payload: { aviones: Array<Record<string, unknown>> } }>;
    }
  ).buildRepartoPayload(Q);
  return r.payload;
}

/** El mundo en pesos con la tarifa AFAC de la ficha del XB-TST (100 USD/hr). */
function conAfac(
  m: Record<string, Fila[]> = mundoPesos(),
): Record<string, Fila[]> {
  return {
    ...m,
    aeronave: m.aeronave.map((a) =>
      a.id === AV ? { ...a, permiso_afac_usd_hr: 100 } : a,
    ),
  };
}

/**
 * La respuesta de HOY con el combustible devuelto a «directos» (como antes
 * del 23-oct-2026): sin `combustible_usd` ni `utilidad_antes_gastos_usd`,
 * `directos_usd` = directos + combustible y el GAS en el grupo DIRECTO.
 * Conserva el ORDEN de las llaves (las nuevas se insertaron junto a las
 * que acompañan), así la comparación con el golden 0101 es byte a byte.
 */
function comoAntesDel0103(r: unknown): unknown {
  const c = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
  for (const a of (c.aviones as Array<Record<string, unknown>>) ?? []) {
    const g = a.gastos as Record<string, number> | undefined;
    if (g) {
      g.directos_usd = r2(g.directos_usd + g.combustible_usd);
      delete g.combustible_usd;
    } else {
      a.gastos_directos_usd = r2(
        (a.gastos_directos_usd as number) + (a.combustible_usd as number),
      );
      delete a.combustible_usd;
    }
    delete a.utilidad_antes_gastos_usd;
    const det = a.detalle as
      | { gastos_por_categoria?: Array<Record<string, unknown>> }
      | undefined;
    for (const f of det?.gastos_por_categoria ?? []) {
      if (f.grupo === 'COMBUSTIBLE') f.grupo = 'DIRECTO';
    }
  }
  return c;
}

describe('Reparto — COMBUSTIBLE APARTE DE LOS GASTOS DIRECTOS (invariante 104)', () => {
  it('1. el GAS es el grupo COMBUSTIBLE: `combustible_*` lo suma y `directos_*` queda sin él (USD y MXN)', async () => {
    const { a } = await avion(mundoPesos());
    const gas = a.detalle.gastos_por_categoria.find(
      (g) => g.categoria === 'GAS',
    );
    expect(gas).toMatchObject({ grupo: 'COMBUSTIBLE', usd: 167.6, mxn: 3000 });
    expect(a.gastos.combustible_usd).toBe(167.6);
    expect(a.gastos.combustible_mxn).toBe(3000);
    // Solo el OPERACIONES (200 USD a 19.5) queda en directos.
    expect(a.gastos.directos_usd).toBe(200);
    expect(a.gastos.directos_mxn).toBe(3900);
    const op = a.detalle.gastos_por_categoria.find(
      (g) => g.categoria === 'OPERACIONES',
    );
    expect(op).toMatchObject({ grupo: 'DIRECTO', usd: 200, mxn: 3900 });
    // Sin oficial el GAS MXN no llega a dólares (sigue en gastos_sin_tc),
    // pero sus pesos sí cuentan como combustible.
    const { a: sinOficial } = await avion(mundoPesos(), null);
    expect(sinOficial.gastos.combustible_usd).toBe(0);
    expect(sinOficial.gastos.combustible_mxn).toBe(3000);
    expect(sinOficial.gastos.directos_usd).toBe(200);
  });

  it('1b. un GAS repartido a mano también va a COMBUSTIBLE (su parte), no a INDIRECTO', async () => {
    const m = mundoPesos();
    m.gasto = [
      ...m.gasto,
      {
        ...gastoBase,
        id: 'g-gas-rep',
        aeronave_id: null,
        vuelo_id: null,
        categoria: 'GAS',
        monto: 1000,
        moneda: 'USD',
        tc_gasto: 20,
        es_reparto_parcial: true,
        notas: 'turbosina repartida',
      },
    ];
    m.gasto_reparto = [
      ...(m.gasto_reparto ?? []),
      { id: 'gr-gas', gasto_id: 'g-gas-rep', aeronave_id: AV, monto: 400 },
    ];
    const { a } = await avion(m);
    const fila = a.detalle.gastos_por_categoria.find((g) =>
      g.categoria.startsWith('GAS ('),
    );
    expect(fila).toMatchObject({ grupo: 'COMBUSTIBLE', usd: 400 });
    expect(a.gastos.combustible_usd).toBe(r2(167.6 + 400));
    expect(a.gastos.indirectos_usd).toBe(100);
  });

  it('2. «Utilidad antes de gastos» = cobrado − comisiones − directos − AFAC, y de ahí − combustible − indirectos − permisos − fijos + otros ingresos = saldo (USD y MXN, al centavo)', async () => {
    const { r } = await avion(conAfac());
    for (const a of r.aviones) {
      expect(a.utilidad_antes_gastos_usd).toBe(
        r2(
          a.ingresos.cobrado_usd -
            a.ingresos.comisiones_venta_usd -
            a.gastos.directos_usd -
            a.afac_reservado_usd,
        ),
      );
      expect(a.saldo_disponible_usd).toBe(
        r2(
          a.utilidad_antes_gastos_usd -
            a.gastos.combustible_usd -
            a.gastos.indirectos_usd -
            a.gastos.permisos_usd -
            a.gastos.otros_prorrateados_usd +
            a.ingresos.otros_ingresos_avion_usd,
        ),
      );
      expect(a.utilidad_antes_gastos_mxn).toBe(
        r2(
          a.ingresos.cobrado_mxn -
            a.ingresos.comisiones_venta_mxn -
            a.gastos.directos_mxn -
            a.afac_reservado_mxn,
        ),
      );
      expect(a.saldo_disponible_mxn).toBe(
        r2(
          a.utilidad_antes_gastos_mxn -
            a.gastos.combustible_mxn -
            a.gastos.indirectos_mxn -
            a.gastos.permisos_mxn -
            a.gastos.otros_prorrateados_mxn +
            a.ingresos.otros_ingresos_avion_mxn,
        ),
      );
    }
    // El XB-TST con AFAC: la provisión resta ANTES del subtotal (como en el
    // Excel: «UTILIDAD ANTES DE GASTOS» ya trae la provisión descontada).
    const tst = r.aviones.find((x) => x.aeronave.id === AV)!;
    expect(tst.afac_reservado_usd).toBeGreaterThan(0);
    expect(tst.utilidad_antes_gastos_usd).toBeLessThan(
      r2(
        tst.ingresos.cobrado_usd -
          tst.ingresos.comisiones_venta_usd -
          tst.gastos.directos_usd,
      ),
    );
  });

  it('3. IDENTIDAD con el golden 0.0.101: directos + combustible = los directos de antes y nada más se movió (byte a byte, con oficial, sin oficial y vacía)', async () => {
    const compute = (
      m: Record<string, Fila[]> = mundoPesos(),
      mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
    ) => servicio(m, mapa).compute(Q);
    const hoy = sinLlavesPesos(await compute()) as {
      aviones: Array<{
        gastos: { directos_usd: number; combustible_usd: number };
        saldo_disponible_usd: number;
      }>;
    };
    const antes = GOLDEN_0101.reparto_oficial as {
      aviones: Array<{
        gastos: { directos_usd: number };
        saldo_disponible_usd: number;
      }>;
    };
    expect(hoy.aviones.length).toBe(antes.aviones.length);
    hoy.aviones.forEach((a, i) => {
      expect(r2(a.gastos.directos_usd + a.gastos.combustible_usd)).toBe(
        antes.aviones[i].gastos.directos_usd,
      );
      expect(a.saldo_disponible_usd).toBe(
        antes.aviones[i].saldo_disponible_usd,
      );
    });
    // El XB-TST del golden: 367.60 de directos = 200 + 167.60 de GAS.
    const tst = hoy.aviones[1];
    expect([tst.gastos.directos_usd, tst.gastos.combustible_usd]).toEqual([
      200, 167.6,
    ]);
    expect(JSON.stringify(comoAntesDel0103(hoy))).toBe(
      JSON.stringify(GOLDEN_0101.reparto_oficial),
    );
    expect(
      JSON.stringify(
        comoAntesDel0103(sinLlavesPesos(await compute(mundoPesos(), null))),
      ),
    ).toBe(JSON.stringify(GOLDEN_0101.reparto_sin_oficial));
    expect(
      JSON.stringify(
        comoAntesDel0103(
          sinLlavesPesos(await compute({ ...mundoPesos(), aeronave: [] })),
        ),
      ),
    ).toBe(JSON.stringify(GOLDEN_0101.reparto_vacio));
    expect(
      JSON.stringify(comoAntesDel0103(sinLlavesPesosPayload(await payload()))),
    ).toBe(JSON.stringify(GOLDEN_0101.payload_oficial));
  });

  it('4. el payload del PDF/XLSX: `combustible_*` y `utilidad_antes_gastos_*` aditivos, `gastos_directos_*` sin combustible y las últimas llaves intactas', async () => {
    const p = await payload();
    const { r } = await avion(mundoPesos());
    for (const a of r.aviones) {
      const pa = p.aviones.find((x) => x.matricula === a.aeronave.matricula)!;
      expect(pa).toMatchObject({
        gastos_directos_usd: a.gastos.directos_usd,
        combustible_usd: a.gastos.combustible_usd,
        utilidad_antes_gastos_usd: a.utilidad_antes_gastos_usd,
        gastos_directos_mxn: a.gastos.directos_mxn,
        combustible_mxn: a.gastos.combustible_mxn,
        utilidad_antes_gastos_mxn: a.utilidad_antes_gastos_mxn,
        saldo_usd: a.saldo_disponible_usd,
      });
    }
    const tst = p.aviones.find((x) => x.matricula === 'XB-TST')!;
    expect([tst.gastos_directos_usd, tst.combustible_usd]).toEqual([
      200, 167.6,
    ]);
    expect(Object.keys(tst).slice(-3)).toEqual([
      'otros_ingresos_avion_usd',
      'otros_ingresos_avion_sin_tc_mxn',
      'otros_ingresos_avion',
    ]);
  });
});
