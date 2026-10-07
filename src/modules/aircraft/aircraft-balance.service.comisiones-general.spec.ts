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
  fuenteTcLegible: (f: string | null | undefined) => f ?? 'TC oficial',
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceEmpresaBloquePayload,
  BalanceGeneralResumenFilaPayload,
  BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  fakeSupabase,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';
import {
  ACC,
  AV2,
  MAU,
  V13,
  V21,
  V22,
  V3,
  V5,
  V6,
  V7,
  conVueloDosComisiones,
  conVueloSinK,
  mundoCierre,
  mundoDosSoloSinK,
} from './comisiones-general.fixture-spec';
import { MARCA_PROVISION_SIN_GASTO_REAL } from '../../common/comisiones-avion.util';

/**
 * COMISIONES: SIN INGRESO DUPLICADO EN «OTROS MOVIMIENTOS» Y `comisiones_usd`
 * EN LA CASCADA DEL GENERAL (7-oct-2026, API 0.0.66). Pedido del cliente:
 * «Estas comisiones se están duplicando en la general, ya que las tenemos en
 * el apartado de "Otros movimientos"» (la columna COMISIONES MXN debe vivir
 * solo en el libro individual de cada avión) y «en "otros movimientos", en el
 * ingreso estás duplicando la comisión» (nota «comisión vendedor (Pablo
 * Canales) = $5,467.97 · comisión del vendedor a cargo del avión … =
 * $5,467.97» ⇒ ingreso $10,935.94).
 *
 * Regla: los aviones siguen absorbiendo su parte de la comisión bancaria y la
 * provisión del vendedor (ganancia, cascada, socios y reparto IGUALES al
 * 0.0.65 — FIXTURE CONGELADO abajo); «otros movimientos» pierde la línea de
 * ingreso «a cargo del avión» y el egreso del vendedor es SOLO lo que el pago
 * real EXCEDE la provisión que ya cargan los aviones; el bloque de cada avión
 * gana `comisiones_usd` (la cifra del reparto) y
 * `utilidad_antes_comisiones_usd` para que la cascada del GENERAL —sin
 * columna COMISIONES en su hoja de vuelos— cuadre con lo que ve el socio.
 *
 * Mundo: `comisiones-general.fixture-spec` (cierre de septiembre con XB-TST y
 * XB-DOS; el #507 es el caso del cliente, $5,467.97).
 */

/** Vigencia POSTERIOR a todo el mundo de septiembre: la regla de siempre. */
const POSTERIOR = '2026-12-01';
/** Vigencia a MITAD del periodo: #507 (4-sep) y #501 (10-sep) quedan antes. */
const MITAD = '2026-09-15';
/**
 * La marca con que pyservices pinta en AMARILLO el pago al vendedor sin gasto
 * real (`_MARCA_PROVISION` de `balance_avion_xlsx.py`, copiada TAL CUAL).
 */
const MARCA_AMARILLO_PYSERVICES = /·\s*PROVISI[OÓ]N\s*\(/;
const r2 = (x: number) => Math.round(x * 100) / 100;

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  resumen: BalanceGeneralResumenFilaPayload[];
  resumen_totales: BalanceGeneralResumenFilaPayload;
  empresa?: BalanceEmpresaBloquePayload;
};

type Mundo = Record<string, Fila[]>;

/** Configuración con la vigencia dada (`undefined` ⇒ su default). */
const config = (vigencia?: string) => ({
  fecha: (_clave: string, porDefecto: string) =>
    Promise.resolve(vigencia ?? porDefecto),
});

function balanceDe(mundo: Mundo, vigencia?: string) {
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const service = new AircraftBalanceService(
    fakeSupabase(mundo).supabase as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        enviados.individual = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
      generateBalanceGeneralXlsx: (p: General) => {
        enviados.general = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
    config(vigencia) as never,
  );
  return { service, enviados };
}

async function libro(
  avion: string,
  vigencia?: string,
  mundo: Mundo = mundoCierre(),
): Promise<BalanceAvionPayload> {
  const b = balanceDe(mundo, vigencia);
  await b.service.xlsx(avion, DESDE, HASTA);
  return b.enviados.individual!;
}

async function general(
  vigencia?: string,
  mundo: Mundo = mundoCierre(),
): Promise<General> {
  const b = balanceDe(mundo, vigencia);
  await b.service.xlsxGeneral(DESDE, HASTA);
  return b.enviados.general!;
}

async function reparto(vigencia?: string, mundo: Mundo = mundoCierre()) {
  const svc = new ProfitSharingService(
    fakeSupabase(mundo).supabase as unknown as SupabaseService,
    {} as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    {} as never,
    config(vigencia) as never,
  );
  return svc.compute({ desde: DESDE, hasta: HASTA });
}

const bloqueDe = (g: General, matricula: string) => {
  const a = g.aviones.find((x) => x.matricula === matricula);
  if (!a) throw new Error(`sin bloque de ${matricula}`);
  return a.balance;
};

const omDe = (g: General, folio: number): BalanceOtroMovimientoFilaPayload => {
  const f = g.consolidado.otros_movimientos!.filas.find((x) =>
    x.clave.endsWith(String(folio)),
  );
  if (!f) throw new Error(`sin fila de otros movimientos del #${folio}`);
  return f;
};

/** [ingreso, egreso, remanente] de cada fila por vuelo, por folio. */
const numerosOm = (g: General): Record<number, Array<number | null>> =>
  Object.fromEntries(
    g.consolidado.otros_movimientos!.filas.map((f) => [
      Number(f.clave.replace(/\D/g, '')),
      [f.ingreso_mxn, f.egreso_mxn, f.remanente_mxn],
    ]),
  );

/** Σ ganancia de los libros + Σ remanente de «otros movimientos». */
function dineroTotal(g: General): number {
  const om = g.consolidado.otros_movimientos!;
  return r2(
    g.consolidado.vuelos.reduce((a, v) => a + (v.ganancia_mxn ?? 0), 0) +
      [...om.filas, ...om.filas_sueltas].reduce(
        (a, f) => a + (f.remanente_mxn ?? 0),
        0,
      ),
  );
}

/** Todo el texto de «otros movimientos» (conceptos y notas). */
const textoOm = (g: General): string =>
  [
    ...g.consolidado.otros_movimientos!.filas,
    ...g.consolidado.otros_movimientos!.filas_sueltas,
  ]
    .flatMap((f) => [
      f.concepto_ingreso,
      f.nota_ingreso,
      f.concepto_egreso,
      f.nota_egreso,
    ])
    .filter(Boolean)
    .join('\n');

/** El mundo sin el pago real del #506 (menor que su provisión). */
function mundoSinFaltante(): Mundo {
  const m = mundoCierre();
  return { ...m, gasto: m.gasto.filter((g) => g.id !== 'g-com-506') };
}

const socios = (montos: [number, number], pct: [number, number]) => [
  {
    nombre: 'Mauricio Roque',
    porcentaje: pct[0],
    monto_usd: montos[0],
    es_empresa: false,
  },
  {
    nombre: 'Aero Charter Cancun S.A. de C.V.',
    porcentaje: pct[1],
    monto_usd: montos[1],
    es_empresa: true,
  },
];

/**
 * FIXTURE CONGELADO — lo que el API 0.0.65 (commit 4a2b87d1) entregaba con
 * `mundoCierre()` y la vigencia default (2026-09-01): el bloque «balance» de
 * cada avión (idéntico en su libro individual y en el general) y el reparto a
 * socios. Capturado el 7-oct-2026 corriendo el 0.0.65 sobre este mundo; el
 * 0.0.66 NO puede mover ni un centavo de aquí.
 */
const BALANCE_0065 = {
  'XB-TST': {
    utilidad_antes_usd: 4682.63,
    combustible_usd: 162.16,
    gastos_indirectos_usd: 0,
    refacciones_usd: 0,
    otros_usd: 0,
    permisos_usd: 0,
    utilidad_despues_usd: 4520.47,
    por_cobrar_usd: 706.28,
    utilidad_cobrada_usd: 3814.19,
    socios: socios([2708.07, 1106.12], [71, 29]),
  },
  'XB-DOS': {
    utilidad_antes_usd: 3570.85,
    combustible_usd: 0,
    gastos_indirectos_usd: 0,
    refacciones_usd: 0,
    otros_usd: 0,
    permisos_usd: 0,
    utilidad_despues_usd: 3570.85,
    por_cobrar_usd: 0,
    utilidad_cobrada_usd: 3570.85,
    socios: socios([1785.43, 1785.43], [50, 50]),
  },
} as const;

/** Lo mismo ANTES de la vigencia (POSTERIOR): el libro del 0.0.64. */
const BALANCE_ANTES = {
  'XB-TST': {
    utilidad_antes_usd: 5000,
    combustible_usd: 162.16,
    gastos_indirectos_usd: 0,
    refacciones_usd: 0,
    otros_usd: 0,
    permisos_usd: 0,
    utilidad_despues_usd: 4837.84,
    por_cobrar_usd: 706.28,
    utilidad_cobrada_usd: 4131.56,
    socios: socios([2933.41, 1198.15], [71, 29]),
  },
  'XB-DOS': {
    utilidad_antes_usd: 4160,
    combustible_usd: 0,
    gastos_indirectos_usd: 0,
    refacciones_usd: 0,
    otros_usd: 0,
    permisos_usd: 0,
    utilidad_despues_usd: 4160,
    por_cobrar_usd: 0,
    utilidad_cobrada_usd: 4160,
    socios: socios([2080, 2080], [50, 50]),
  },
} as const;

/** Reparto a socios del 0.0.65 (sin cambio de código en el 0.0.66). */
const REPARTO_0065 = {
  [AV]: {
    comisiones_venta_usd: 292.37,
    saldo_disponible_usd: 3501.35,
    reparto: [
      [MAU, 2485.96],
      [ACC, 1015.39],
    ],
    vuelos: [
      ['v-1', 95.7],
      [V3, 66.67],
      [V6, 130],
    ],
  },
  [AV2]: {
    comisiones_venta_usd: 589.14,
    saldo_disponible_usd: 3570.86,
    reparto: [
      [MAU, 1785.43],
      [ACC, 1785.43],
    ],
    vuelos: [
      [V7, 322.48],
      [V3, 66.66],
      [V5, 150],
      ['v-14', 50],
    ],
  },
} as const;

/** «Otros movimientos» del 0.0.65: [ingreso, egreso, remanente] por folio. */
const OM_0065: Record<number, Array<number | null>> = {
  507: [10935.94, 5467.97, 5467.97],
  501: [6200, 3136.1, 3063.9],
  503: [3600, 1830, 1770],
  504: [null, 900, -900],
  505: [5400, 3000, 2400],
  506: [3600, 1554, 2046],
  513: [1440, 1476, -36],
  514: [900, 45, 855],
};

/** «Otros movimientos» ANTES de la vigencia (0.0.64 = 0.0.65). */
const OM_ANTES: Record<number, Array<number | null>> = {
  507: [5467.97, 5467.97, 0],
  501: [4600, 3450, 1150],
  503: [1800, 2430.01, -630.01],
  504: [null, 900, -900],
  505: [2700, 3000, -300],
  506: [1800, 2094, -294],
  513: [1440, 1926, -486],
  514: [900, 945, -45],
};

/** Bloque VUELATOUR (empresa) del 0.0.65. */
const EMPRESA_0065 = {
  participacion_usd: 2891.55,
  ingresos_propios_usd: 1784.96,
  pagos_vendedor_usd: 986.66,
  otros_gastos_empresa_usd: 38.72,
  resultado_usd: 3651.13,
};
/** El mismo bloque del 0.0.65 en `mundoSinFaltante()`. */
const EMPRESA_0065_SIN_FALTANTE = {
  participacion_usd: 2891.55,
  ingresos_propios_usd: 1784.96,
  pagos_vendedor_usd: 1003.33,
  otros_gastos_empresa_usd: 38.72,
  resultado_usd: 3634.46,
};

const MATRICULAS = ['XB-TST', 'XB-DOS'] as const;

/** El bloque sin las dos llaves del 0.0.66: lo que entregaba el 0.0.65. */
function sinLlavesNuevas(
  b: BalanceAvionPayload['balance'],
): Record<string, unknown> {
  const resto: Record<string, unknown> = { ...b };
  delete resto.comisiones_usd;
  delete resto.utilidad_antes_comisiones_usd;
  return resto;
}
const ID_DE = { 'XB-TST': AV, 'XB-DOS': AV2 } as const;

describe('Utilidad cobrada por avión: IDÉNTICA al 0.0.65 (fixture congelado)', () => {
  it('libro INDIVIDUAL de cada avión: cascada y socios al centavo; las dos llaves nuevas van AL FINAL del bloque', async () => {
    for (const m of MATRICULAS) {
      const b = (await libro(ID_DE[m])).balance;
      expect(sinLlavesNuevas(b)).toEqual(BALANCE_0065[m]);
      expect(Object.keys(b).slice(-2)).toEqual([
        'comisiones_usd',
        'utilidad_antes_comisiones_usd',
      ]);
    }
  });

  it('GENERAL: el bloque de cada avión es el MISMO de su libro individual (y del 0.0.65)', async () => {
    const g = await general();
    for (const m of MATRICULAS) {
      const b = bloqueDe(g, m);
      expect(b).toEqual((await libro(ID_DE[m])).balance);
      expect(sinLlavesNuevas(b)).toEqual(BALANCE_0065[m]);
    }
  });

  it('reparto a socios: comisiones, saldo, montos y detalle por vuelo sin un centavo de diferencia', async () => {
    const r = await reparto();
    for (const a of r.aviones) {
      const congelado =
        REPARTO_0065[a.aeronave.id as keyof typeof REPARTO_0065];
      expect({
        comisiones_venta_usd: a.ingresos.comisiones_venta_usd,
        saldo_disponible_usd: a.saldo_disponible_usd,
        reparto: a.reparto.map((x) => [x.socio_id, x.monto_usd]),
        vuelos: a.detalle.vuelos.map((v) => [v.id, v.comisiones_avion_usd]),
      }).toEqual(congelado);
    }
  });

  it('RESUMEN del general: conserva su columna COMISIONES MXN y su ganancia de siempre', async () => {
    const g = await general();
    expect(
      g.resumen.map((r) => [r.matricula, r.comisiones_mxn, r.ganancia_mxn]),
    ).toEqual([
      ['XB-DOS', 10267.97, 63400.99],
      ['XB-TST', 5903.91, 85096.09],
      ['EXTERNOS', 0, 9000],
    ]);
    expect([
      g.resumen_totales.comisiones_mxn,
      g.resumen_totales.ganancia_mxn,
    ]).toEqual([16171.88, 157497.08]);
  });

  it('ANTES de la vigencia: el bloque del 0.0.64, SIN las llaves nuevas', async () => {
    const g = await general(POSTERIOR);
    for (const m of MATRICULAS) {
      const ind = (await libro(ID_DE[m], POSTERIOR)).balance;
      expect(ind).toEqual(BALANCE_ANTES[m]);
      expect('comisiones_usd' in ind).toBe(false);
      expect('utilidad_antes_comisiones_usd' in ind).toBe(false);
      expect(bloqueDe(g, m)).toEqual(BALANCE_ANTES[m]);
    }
  });
});

describe('`balance.comisiones_usd` — la MISMA cifra que el reparto (fuente única)', () => {
  it('XB-DOS: == `ingresos.comisiones_venta_usd` del reparto al centavo (Σ por vuelo de `comisionesDelVuelo(...).total_usd`)', async () => {
    const b = (await libro(AV2)).balance;
    const r = await reparto();
    const dos = r.aviones.find((a) => a.aeronave.id === AV2)!;
    expect(b.comisiones_usd).toBe(589.14);
    expect(b.comisiones_usd).toBe(dos.ingresos.comisiones_venta_usd);
    expect(b.comisiones_usd).toBe(
      r2(
        dos.detalle.vuelos.reduce(
          (a, v) => a + (v.comisiones_avion_usd ?? 0),
          0,
        ),
      ),
    );
  });

  it('XB-TST: el reparto + la comisión bancaria del anticipo del #513 CONFIRMADO (el balance cuenta su cobro; el reparto no lee el vuelo): 292.37 + 25.00', async () => {
    const p = await libro(AV);
    const r = await reparto();
    const tst = r.aviones.find((a) => a.aeronave.id === AV)!;
    expect(tst.detalle.vuelos.some((v) => v.id === V13)).toBe(false);
    // 486 ÷ 18 = 27 USD × 1,000/1,080 = 25.00 (comisión bancaria del anticipo).
    const anticipo = p.vuelos.find((v) => v.vuelo_id === V13)!;
    expect(anticipo.comision_banco_avion_mxn).toBe(450);
    expect(p.balance.comisiones_usd).toBe(317.37);
    expect(
      r2((p.balance.comisiones_usd ?? 0) - tst.ingresos.comisiones_venta_usd),
    ).toBe(25);
  });

  it('cascada del general: «antes de comisiones» − COMISIONES == `utilidad_antes_usd` al centavo (la fórmula de pyservices) y el resto de la cascada no se mueve', async () => {
    const g = await general();
    for (const m of MATRICULAS) {
      const b = bloqueDe(g, m);
      expect(b.utilidad_antes_comisiones_usd).toBe(
        r2(b.utilidad_antes_usd + (b.comisiones_usd ?? NaN)),
      );
      expect(
        r2((b.utilidad_antes_comisiones_usd ?? NaN) - (b.comisiones_usd ?? 0)),
      ).toBe(b.utilidad_antes_usd);
    }
    // XB-TST: la utilidad antes de comisiones es la de antes de la regla.
    expect(bloqueDe(g, 'XB-TST').utilidad_antes_comisiones_usd).toBe(5000);
    // XB-DOS: 3,570.85 + 589.14 = 4,159.99 — un centavo bajo los 4,160.00
    // de la regla anterior: el reparto redondea la comisión en USD por vuelo
    // (#503: 16.66 + 50) y la fila redondea su ganancia neta (933.33).
    expect(bloqueDe(g, 'XB-DOS').utilidad_antes_comisiones_usd).toBe(4159.99);
  });

  it('libro con filas de la vigencia SIN comisiones: las llaves viajan en 0 (antes de comisiones = utilidad antes)', async () => {
    const m = mundoCierre();
    const sinComisiones: Mundo = {
      ...m,
      vuelo: m.vuelo.filter((v) => v.id === V5),
      cobro_vuelo: m.cobro_vuelo.filter((c) => c.vuelo_id === V5),
      escala: [],
      gasto: [],
    };
    sinComisiones.vuelo = sinComisiones.vuelo.map((v) => ({
      ...v,
      comision_vendedor_usd: 0,
      comision_vendedor_nombre: null,
      monto_total_usd: 1000,
      monto_total_mxn: 18000,
    }));
    const b = (await libro(AV2, undefined, sinComisiones)).balance;
    expect(b.comisiones_usd).toBe(0);
    expect(b.utilidad_antes_comisiones_usd).toBe(b.utilidad_antes_usd);
  });
});

/**
 * REVISIÓN 7-oct-2026 del 0.0.66: qué filas suman a `comisiones_usd`. La
 * regla: lo que la fila RESTÓ. Con K, la cifra del reparto; sin K, lo que
 * restó en pesos ÷ el T.C. de su ganancia (jamás la provisión del vendedor
 * que no llegó a pesos); sin ganancia USD, nada.
 */
describe('`balance.comisiones_usd` — vigencia a mitad del periodo y filas sin T.C. (revisión del 0.0.66)', () => {
  it('vigencia a MITAD del periodo (15-sep): solo suman las filas desde la vigencia (XB-DOS == reparto; XB-TST == reparto + el anticipo del #513) y «antes de comisiones» no depende de la fecha de la vigencia', async () => {
    const g = await general(MITAD);
    const r = await reparto(MITAD);
    const dos = r.aviones.find((a) => a.aeronave.id === AV2)!;
    const tst = r.aviones.find((a) => a.aeronave.id === AV)!;
    // #507 (4-sep) queda antes de la vigencia: no aporta en ningún lado.
    expect(
      dos.detalle.vuelos.find((v) => v.id === V7)!.comisiones_avion_usd ?? 0,
    ).toBe(0);
    // 66.66 (#503) + 150 (#505) + 50 (#514).
    expect(bloqueDe(g, 'XB-DOS').comisiones_usd).toBe(266.66);
    expect(bloqueDe(g, 'XB-DOS').comisiones_usd).toBe(
      dos.ingresos.comisiones_venta_usd,
    );
    // 66.67 (#503) + 130 (#506) del reparto + 25.00 del anticipo del #513.
    expect(bloqueDe(g, 'XB-TST').comisiones_usd).toBe(221.67);
    expect(
      r2(
        (bloqueDe(g, 'XB-TST').comisiones_usd ?? 0) -
          tst.ingresos.comisiones_venta_usd,
      ),
    ).toBe(25);
    // La utilidad ANTES de comisiones es la misma con la vigencia el 1-sep
    // que a mitad de mes (solo cambia cuánto se resta después).
    const d = await general();
    for (const m of MATRICULAS) {
      expect(bloqueDe(g, m).utilidad_antes_comisiones_usd).toBe(
        bloqueDe(d, m).utilidad_antes_comisiones_usd,
      );
      expect(
        r2(
          (bloqueDe(g, m).utilidad_antes_comisiones_usd ?? NaN) -
            (bloqueDe(g, m).comisiones_usd ?? 0),
        ),
      ).toBe(bloqueDe(g, m).utilidad_antes_usd);
    }
    // En el libro, las filas anteriores a la vigencia no traen COMISIONES.
    const p = await libro(AV, MITAD);
    expect(
      p.vuelos
        .filter((v) => v.comisiones_detalle !== undefined)
        .map((v) => Number(v.folio)),
    ).toEqual([503, 506, 513]);
  });

  it('vuelo SIN K (#521): suma lo que la fila RESTÓ —su parte de la comisión bancaria, en pesos ÷ el T.C. de su ganancia—, nunca la provisión del vendedor que no llegó a pesos; «antes de comisiones» no se mueve', async () => {
    const mundo = conVueloSinK(mundoCierre());
    const p = await libro(AV2, undefined, mundo);
    const f = p.vuelos.find((v) => v.vuelo_id === V21)!;
    // 396 × 1,000/1,100 = 360 de banco; la provisión (100 USD) no llega a
    // pesos y sin K la venta tampoco: remanente 0, ganancia −360.
    expect([
      f.comision_banco_avion_mxn,
      f.comision_vendedor_prov_mxn,
      f.comisiones_mxn,
      f.remanente_mxn,
      f.ganancia_mxn,
    ]).toEqual([360, 0, 360, 0, -360]);
    expect(
      p.pendientes.some(
        (x) =>
          x.includes('#521') &&
          x.includes('comisión del vendedor sin TC de venta'),
      ),
    ).toBe(true);
    // La ganancia USD de la fila: −360 ÷ el T.C. promedio del libro (sin K
    // ni T.C. de costos) = −20.29; restó 20.29 USD de comisiones.
    expect(f.tc_costos).toBeNull();
    expect(f.ganancia_usd).toBe(-20.29);
    expect(p.balance.comisiones_usd).toBe(r2(589.14 + 20.29));
    // Remanente 0 ⇒ el vuelo no mueve la utilidad ANTES de comisiones: la
    // del cierre sin él (con `total_usd` salía 100 USD inflada).
    expect(p.balance.utilidad_antes_comisiones_usd).toBe(4159.99);
    expect(
      r2(
        (p.balance.utilidad_antes_comisiones_usd ?? NaN) -
          (p.balance.comisiones_usd ?? 0),
      ),
    ).toBe(p.balance.utilidad_antes_usd);
    // El reparto SÍ descuenta la provisión en USD (no necesita K): 120 por
    // el #521; la diferencia con el balance la grita el pendiente de arriba.
    const r = await reparto(undefined, mundo);
    const dos = r.aviones.find((a) => a.aeronave.id === AV2)!;
    expect(
      dos.detalle.vuelos.find((v) => v.id === V21)!.comisiones_avion_usd,
    ).toBe(120);
    expect(dos.ingresos.comisiones_venta_usd).toBe(709.14);
  });

  it('libro sin NINGÚN T.C. (XB-DOS solo con el #521): la fila resta en pesos pero no tiene ganancia USD ⇒ `comisiones_usd` 0 y «antes de comisiones» == utilidad antes', async () => {
    const p = await libro(AV2, undefined, mundoDosSoloSinK());
    const f = p.vuelos.find((v) => v.vuelo_id === V21)!;
    expect([f.comisiones_mxn, f.ganancia_mxn, f.ganancia_usd]).toEqual([
      360,
      -360,
      null,
    ]);
    expect(p.tc_promedio).toBeNull();
    expect(p.balance.comisiones_usd).toBe(0);
    expect(p.balance.utilidad_antes_comisiones_usd).toBe(
      p.balance.utilidad_antes_usd,
    );
  });
});

describe('«Otros movimientos» SIN la comisión duplicada (API 0.0.66)', () => {
  it('ninguna fila ni nota trae la línea de ingreso «a cargo del avión»', async () => {
    const texto = textoOm(await general());
    expect(texto).not.toMatch(/a cargo del avi[oó]n/);
    expect(texto).not.toMatch(/regla sep-2026/);
  });

  it('caso del cliente (#507, $5,467.97): el ingreso cobrado aparece UNA vez y el egreso del vendedor es 0, cubierto por el avión; el remanente es el del 0.0.65', async () => {
    const om = omDe(await general(), 507);
    expect(om.concepto_ingreso).toBe('comisión vendedor (Pablo Canales)');
    expect(om.ingreso_mxn).toBe(5467.97);
    expect(om.concepto_egreso).toBe(
      'pago comisión vendedor (Pablo Canales) · cubierto por el avión XB-DOS (provisión $5,467.97 en su balance) · PROVISIÓN (sin gasto real capturado)',
    );
    expect(om.egreso_mxn).toBe(0);
    expect(om.fecha_egreso).toBe('2026-09-04');
    expect(om.remanente_mxn).toBe(OM_0065[507][2]);
  });

  it('#501 (fila colapsada): ingreso 4,600 sin los 1,600 de la línea duplicada; egreso = TUAS + parte VuelaTour de la comisión bancaria; remanente igual', async () => {
    const om = omDe(await general(), 501);
    expect(om.ingreso_mxn).toBe(4600);
    expect(om.egreso_mxn).toBe(1536.1);
    expect(om.remanente_mxn).toBe(OM_0065[501][2]);
    expect(om.nota_ingreso).toBe(
      [
        'comisión vendedor (Vendedor Uno) = $1,600.00',
        'tuas/extras/pernocta cobrados + iva (sin desglose canónico: estimado con columnas) = $3,000.00',
      ].join('\n'),
    );
    expect(om.nota_egreso).toBe(
      [
        'pago comisión vendedor (Vendedor Uno) · cubierto por el avión XB-TST (provisión $1,600.00 en su balance) · PROVISIÓN (sin gasto real capturado) = $0.00',
        'tuas pagadas = $1,500.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $36.10',
      ].join('\n'),
    );
  });

  it('MULTI-AVIÓN (#503): el pago lo cubren los dos aviones con SU provisión; VuelaTour solo paga su parte de la comisión bancaria', async () => {
    const om = omDe(await general(), 503);
    expect(om.ingreso_mxn).toBe(1800);
    expect(om.egreso_mxn).toBe(30);
    expect(om.remanente_mxn).toBe(OM_0065[503][2]);
    expect(om.nota_egreso).toBe(
      [
        'pago comisión vendedor (Pablo Canales) · cubierto por los aviones XB-DOS (provisión $900.00 en su balance) y XB-TST (provisión $900.00 en su balance) · PROVISIÓN (sin gasto real capturado) = $0.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $30.00',
      ].join('\n'),
    );
  });

  it('pago real MAYOR que la provisión (#505): VuelaTour paga SOLO el exceso con «excede»; remanente igual al 0.0.65', async () => {
    const om = omDe(await general(), 505);
    expect(om.ingreso_mxn).toBe(2700);
    expect(om.egreso_mxn).toBe(300);
    expect(om.concepto_egreso).toBe(
      'pago comisión vendedor (Pablo Canales) · cubierto por el avión XB-DOS (provisión $2,700.00 en su balance) · gasto real $3,000.00 · excede $300.00 MXN',
    );
    expect(om.fecha_egreso).toBe('2026-09-28');
    expect(om.remanente_mxn).toBe(OM_0065[505][2]);
  });

  it('pago real MENOR que la provisión (#506): egreso del vendedor 0 con «parcial: faltan» (aún se le debe; el avión ya lo cargó): el remanente baja exactamente esos 300 respecto al 0.0.65', async () => {
    const om = omDe(await general(), 506);
    expect(om.ingreso_mxn).toBe(1800);
    expect(om.egreso_mxn).toBe(54);
    expect(om.nota_egreso).toContain(
      'pago comisión vendedor (Alex Saab) · cubierto por el avión XB-TST (provisión $1,800.00 en su balance) · gasto real $1,500.00 · parcial: faltan $300.00 MXN = $0.00',
    );
    expect(om.remanente_mxn).toBe(r2((OM_0065[506][2] ?? 0) - 300));
  });

  it('vuelo AÚN NO realizado (#513 CONFIRMADO) y EXTERNO (#504): ningún avión carga provisión ⇒ la pestaña de siempre', async () => {
    const g = await general();
    const confirmado = omDe(g, 513);
    expect(confirmado.nota_egreso).toContain(
      'pago comisión vendedor (Saab) · PROVISIÓN (mismo monto que lo cobrado: comisión + IVA; sin gasto real capturado) = $1,440.00',
    );
    const externo = omDe(g, 504);
    expect(externo.concepto_egreso).toBe('comisión bancaria');
    expect(externo.egreso_mxn).toBe(900);
    const n = numerosOm(g);
    expect([n[513], n[504], n[514]]).toEqual([
      OM_0065[513],
      OM_0065[504],
      OM_0065[514],
    ]);
  });

  it('cada fila por vuelo: el remanente del 0.0.65 se conserva (salvo el faltante del #506) y solo baja el ingreso por la línea quitada', async () => {
    const n = numerosOm(await general());
    for (const folio of [507, 501, 503, 504, 505, 513, 514]) {
      expect([folio, n[folio][2]]).toEqual([folio, OM_0065[folio][2]]);
    }
    // La línea quitada era la provisión de los aviones: el ingreso baja eso
    // y el egreso baja lo mismo (la provisión que ya no paga VuelaTour).
    expect(r2((OM_0065[507][0] ?? 0) - (n[507][0] ?? 0))).toBe(5467.97);
    expect(r2((OM_0065[503][0] ?? 0) - (n[503][0] ?? 0))).toBe(1800);
  });

  it('el pago al vendedor SIN gasto real conserva la marca de PROVISIÓN (el amarillo de pyservices, pedido del 6-oct); con gasto real, no', async () => {
    const g = await general();
    const amarillo = (f: BalanceOtroMovimientoFilaPayload) =>
      [f.concepto_egreso, f.nota_egreso].some(
        (t) => t != null && MARCA_AMARILLO_PYSERVICES.test(t),
      );
    // #507, #501 y #503: completados de la regla sin gasto real (los cubre
    // el avión con su provisión, egreso 0); #513: CONFIRMADO con la
    // provisión de siempre. #505 y #506 ya tienen gasto real.
    expect(
      g.consolidado
        .otros_movimientos!.filas.filter(amarillo)
        .map((f) => Number(f.clave.replace(/\D/g, '')))
        .sort((a, b) => a - b),
    ).toEqual([501, 503, 507, 513]);
    expect(omDe(g, 507).concepto_egreso).toContain(
      `en su balance)${MARCA_PROVISION_SIN_GASTO_REAL}`,
    );
    expect(omDe(g, 507).egreso_mxn).toBe(0);
    for (const folio of [505, 506]) {
      expect([folio, amarillo(omDe(g, folio))]).toEqual([folio, false]);
    }
  });

  it('DOS líneas COMISION_VENDEDOR (#522) y pago real mayor que la provisión: el exceso egresa UNA sola vez; sin pago, la marca de PROVISIÓN va una sola vez', async () => {
    const conPago = conVueloDosComisiones(mundoCierre(), 3000);
    // La fila del avión carga la provisión de las DOS líneas (150 USD × 18).
    const f = (await libro(AV2, undefined, conPago)).vuelos.find(
      (v) => v.vuelo_id === V22,
    )!;
    expect(f.comision_vendedor_prov_mxn).toBe(2700);
    const om = omDe(await general(undefined, conPago), 522);
    expect(om.nota_ingreso).toBe(
      [
        'comisión vendedor (Pablo Canales) = $1,800.00',
        'comisión vendedor (Pablo Canales) = $900.00',
      ].join('\n'),
    );
    expect(om.ingreso_mxn).toBe(2700);
    // 3,000 − 2,700 = 300, UNA vez (no 300 por cada línea).
    expect(om.egreso_mxn).toBe(300);
    expect(om.nota_egreso).toBe(
      'pago comisión vendedor (Pablo Canales) · cubierto por el avión XB-DOS (provisión $2,700.00 en su balance) · gasto real $3,000.00 · excede $300.00 MXN = $300.00',
    );
    expect(om.remanente_mxn).toBe(2400);
    const sinPago = omDe(
      await general(undefined, conVueloDosComisiones(mundoCierre(), null)),
      522,
    );
    expect([
      sinPago.ingreso_mxn,
      sinPago.egreso_mxn,
      sinPago.remanente_mxn,
    ]).toEqual([2700, 0, 2700]);
    expect(sinPago.nota_egreso).toBe(
      'pago comisión vendedor (Pablo Canales) · cubierto por el avión XB-DOS (provisión $2,700.00 en su balance) · PROVISIÓN (sin gasto real capturado) = $0.00',
    );
  });

  it('vigencia a MITAD del periodo (15-sep): las filas de vuelos anteriores son las de la regla anterior byte a byte y las posteriores, las de la vigencia del 1-sep', async () => {
    const filas = async (vigencia?: string) =>
      new Map(
        (await general(vigencia)).consolidado.otros_movimientos!.filas.map(
          (f) => [Number(f.clave.replace(/\D/g, '')), f],
        ),
      );
    const mitad = await filas(MITAD);
    const antes = await filas(POSTERIOR);
    const desdeSep = await filas();
    for (const folio of [507, 501, 504]) {
      expect([folio, mitad.get(folio)]).toEqual([folio, antes.get(folio)]);
    }
    for (const folio of [503, 504, 505, 506, 513, 514]) {
      expect([folio, mitad.get(folio)]).toEqual([folio, desdeSep.get(folio)]);
    }
    expect(mitad.size).toBe(8);
  });

  it('ANTES de la vigencia: la pestaña del 0.0.64/0.0.65, número por número (sin «cubierto por el avión»)', async () => {
    const g = await general(POSTERIOR);
    expect(numerosOm(g)).toEqual(OM_ANTES);
    expect(textoOm(g)).not.toMatch(/cubierto por/);
  });
});

describe('Bloque VUELATOUR (empresa) y conservación del dinero (API 0.0.66)', () => {
  it('el bloque sale de las filas: ingresos propios = lo cobrado a los clientes (como antes de la regla); egresos sin la provisión que cubren los aviones; participación igual al 0.0.65', async () => {
    const con = (await general()).empresa!;
    const antes = (await general(POSTERIOR)).empresa!;
    expect(con.participacion_usd).toBe(EMPRESA_0065.participacion_usd);
    expect(con.ingresos_propios_usd).toBe(antes.ingresos_propios_usd);
    expect(con.ingresos_propios_usd).toBe(1032.48);
    expect(con.pagos_vendedor_usd).toBe(250.85);
    expect(con.otros_gastos_empresa_usd).toBe(
      EMPRESA_0065.otros_gastos_empresa_usd,
    );
    // El 0.0.65 contaba como ingreso de VuelaTour los 300 que aún se le
    // deben al vendedor del #506 (300 ÷ 18 = 16.67 USD).
    expect(con.resultado_usd).toBe(r2(EMPRESA_0065.resultado_usd - 16.67));
    expect(con.resultado_usd).toBe(
      r2(
        (con.participacion_usd ?? 0) +
          (con.ingresos_propios_usd ?? 0) -
          (con.pagos_vendedor_usd ?? 0) -
          (con.otros_gastos_empresa_usd ?? 0),
      ),
    );
  });

  it('la nota del bloque precisa que, en los vuelos completados de la regla, el egreso del vendedor es solo lo que el pago real EXCEDE la provisión; antes de la vigencia, la de siempre', async () => {
    const precisa =
      'Egresos = pago al vendedor (real o provisión; en los vuelos completados de la regla de comisiones, solo lo que el pago real exceda la provisión que ya carga el avión), TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.';
    expect((await general()).empresa!.nota).toContain(precisa);
    const siempre =
      'Egresos = pago al vendedor (real o provisión), TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.';
    const antes = (await general(POSTERIOR)).empresa!.nota;
    expect(antes).toContain(siempre);
    expect(antes).not.toContain('en los vuelos completados');
    // Vuelo DE la vigencia sin comisiones (ni banco ni vendedor): ningún
    // avión cubre un pago al vendedor ⇒ la nota de siempre.
    const m = mundoCierre();
    const sinComisiones: Mundo = {
      ...m,
      vuelo: m.vuelo
        .filter((v) => v.id === V5)
        .map((v) => ({
          ...v,
          comision_vendedor_usd: 0,
          comision_vendedor_nombre: null,
          monto_total_usd: 1000,
          monto_total_mxn: 18000,
        })),
      cobro_vuelo: m.cobro_vuelo.filter((c) => c.vuelo_id === V5),
      escala: [],
      gasto: [],
    };
    const nota = (await general(undefined, sinComisiones)).empresa!.nota;
    expect(nota).toContain(siempre);
    expect(nota).not.toContain('en los vuelos completados');
  });

  it('sin pagos por debajo de la provisión, el resultado de la empresa es IDÉNTICO al 0.0.65 (quitar la línea duplicada no mueve el dinero)', async () => {
    const con = (await general(undefined, mundoSinFaltante())).empresa!;
    expect(con.resultado_usd).toBe(EMPRESA_0065_SIN_FALTANTE.resultado_usd);
    expect(con.participacion_usd).toBe(
      EMPRESA_0065_SIN_FALTANTE.participacion_usd,
    );
    // Ingresos y egresos bajan EXACTAMENTE lo mismo (la provisión duplicada).
    expect(
      r2(
        EMPRESA_0065_SIN_FALTANTE.ingresos_propios_usd -
          (con.ingresos_propios_usd ?? 0),
      ),
    ).toBe(
      r2(
        EMPRESA_0065_SIN_FALTANTE.pagos_vendedor_usd -
          (con.pagos_vendedor_usd ?? 0),
      ),
    );
  });

  it('conservación: Σ ganancia de los libros + Σ remanente de «otros movimientos» == la regla anterior (menos el faltante del #506, que aún se le debe al vendedor)', async () => {
    expect(dineroTotal(await general(undefined, mundoSinFaltante()))).toBe(
      dineroTotal(await general(POSTERIOR, mundoSinFaltante())),
    );
    expect(dineroTotal(await general())).toBe(
      r2(dineroTotal(await general(POSTERIOR)) - 300),
    );
  });
});
