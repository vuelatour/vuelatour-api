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
  AVION,
  DESDE,
  HASTA,
  VUELATOUR,
  fakeSupabase,
  gastoComision,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';
import {
  ACC,
  AV2,
  MAU,
  V13,
  V14,
  V21,
  V22,
  V3,
  V4,
  V5,
  V6,
  V7,
  conVueloDosComisiones,
  conVueloSinK,
  mundoCierre,
  mundoDosSoloSinK,
} from './comisiones-general.fixture-spec';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004 (0.0.87 byte a byte); la conducta con la
// migración vive en los specs `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

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
 *
 * 12-oct-2026 (API 0.0.73, invariante 58; pedido del cliente: «los gastos
 * que todavía no se hacen no deben aparecer», señalando las filas en
 * amarillo): SIN gasto real `COMISION_VENDEDOR` la fila de «otros
 * movimientos» ya NO lleva egreso del vendedor —ni «cubierto por el avión …
 * · PROVISIÓN … = $0.00» en la vigencia, ni la PROVISIÓN por el mismo monto
 * antes de ella—; el ingreso cobrado se queda y el remanente es ingreso −
 * egresos reales. Con gasto real todo sigue byte a byte (#505 excede, #506
 * parcial). Consecuencia aceptada: en vuelos SIN provisión del avión (#513
 * CONFIRMADO, y todos antes de la vigencia) el remanente y el bloque
 * VUELATOUR suben lo que valía la provisión. La hoja viaja con
 * `sin_provision_vendedor: true`.
 *
 * 13-oct-2026 (API 0.0.74, invariante 61; decisión 3 del lote del cliente:
 * «comisión del vendedor SOLO como gasto real»): la PROVISIÓN murió también
 * en COMISIONES y en el reparto. Lo que el avión absorbe del vendedor es su
 * PAGO REAL (gastos `COMISION_VENDEDOR` del vuelo × su parte), solo en los
 * vuelos COMPLETADOS de la vigencia con comisión cotizada y partición
 * consistente; sin gasto, solo la bancaria. En esos vuelos «otros
 * movimientos» trae el pago apareado con egreso $0.00 «a cargo del avión
 * …» (nunca dos veces); fuera de ese universo VuelaTour lo paga con las
 * ramas de siempre. FIXTURE RE-CONGELADO como «0.0.74» (números
 * verificados a mano abajo; el del 0.0.65 queda en los comentarios).
 *
 * AJUSTE del mismo 13-oct-2026 (DOS categorías): lo que el avión absorbe es
 * SOLO la «Comisión del vendedor (avión)» (los pagos del #505 y el #506 de
 * `mundoCierre()` se re-apuntaron a ella: los goldens «0.0.74» conservan sus
 * cifras), en COMPLETADO o CANCELADO con cobros retenidos y en CUALQUIER
 * fecha (la vigencia ya solo gobierna la parte bancaria). La «Comisión del
 * vendedor (VuelaTour)» la paga siempre VuelaTour: los casos «antes de la
 * vigencia, byte a byte» corren con `aVuelatour(mundo)`.
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

/**
 * El mismo mundo con los pagos capturados como «Comisión del vendedor
 * (VuelaTour)» (13-oct-2026): ningún avión los carga, en ninguna fecha.
 */
function aVuelatour(m: Mundo): Mundo {
  return {
    ...m,
    gasto: m.gasto.map((g) =>
      g.categoria === AVION ? { ...g, categoria: VUELATOUR } : g,
    ),
  };
}

/** El mundo sin el pago real del #506 (1,500 MXN, menor que lo cobrado). */
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
 * FIXTURE CONGELADO «0.0.74» — `mundoCierre()` con la vigencia default
 * (2026-09-01): el bloque «balance» de cada avión (idéntico en su libro
 * individual y en el general). Verificado a mano por fila (ganancia USD =
 * round2((REMANENTE − COMISIONES) ÷ T.C. de costos)):
 *  - XB-TST: #501 (40,000 − 313.90) ÷ 20 = 1,984.30; #503 (18,000 − 300.01)
 *    ÷ 18 = 983.33; #506 (18,000 − 540 − 1,500) ÷ 18 = 886.67; #513
 *    (18,000 − 450) ÷ 18 = 975.00 ⇒ utilidad antes 4,829.30 (= 5,000 «antes
 *    de comisiones» − 170.70 de COMISIONES USD); − 162.16 de combustible =
 *    4,667.14; − 706.28 por cobrar = 3,960.86 ⇒ 71 % 2,812.21 / 29 %
 *    1,148.65 (residuo mayor). 0.0.65: 4,682.63 (con las provisiones).
 *  - XB-DOS: #507 19,668.96 ÷ 16.956 = 1,160.00 (sin gasto: nada del
 *    vendedor; el 0.0.65 restaba 5,467.97 de provisión); #503 (18,000 −
 *    300) ÷ 18 = 983.33; #505 (18,000 − 3,000) ÷ 18 = 833.33; #514 (18,000
 *    − 900) ÷ 18 = 950.00 ⇒ 3,926.66 (= 4,159.99 − 233.33) ⇒ 50 % 1,963.33
 *    cada uno. 0.0.65: 3,570.85. Desde el 0.0.98 (invariante 96, regla B)
 *    la ganancia USD de cada fila es venta USD − costo USD gasto por gasto −
 *    comisiones USD del reparto, así que «antes de comisiones» vuelve a ser
 *    4,160.00 exacto ⇒ 3,926.67 (= el `saldo_disponible_usd` del reparto de
 *    XB-DOS, al centavo) ⇒ 50 % 1,963.34 cada uno.
 */
const BALANCE_0074 = {
  'XB-TST': {
    utilidad_antes_usd: 4829.3,
    combustible_usd: 162.16,
    gastos_indirectos_usd: 0,
    refacciones_usd: 0,
    otros_usd: 0,
    permisos_usd: 0,
    utilidad_despues_usd: 4667.14,
    por_cobrar_usd: 706.28,
    utilidad_cobrada_usd: 3960.86,
    socios: socios([2812.21, 1148.65], [71, 29]),
  },
  'XB-DOS': {
    utilidad_antes_usd: 3926.67,
    combustible_usd: 0,
    gastos_indirectos_usd: 0,
    refacciones_usd: 0,
    otros_usd: 0,
    permisos_usd: 0,
    utilidad_despues_usd: 3926.67,
    por_cobrar_usd: 0,
    utilidad_cobrada_usd: 3926.67,
    socios: socios([1963.34, 1963.34], [50, 50]),
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

/**
 * Reparto a socios «0.0.74» (USD, ÷ K de cada vuelo):
 *  - XB-TST: #501 banco 350 ÷ 20 = 17.50 × 2,000/2,230 = 15.70; #503 banco
 *    630.01 ÷ 18 = 35.00 × 2,000/2,100 = 33.33 ⇒ 16.67 (principal); #506
 *    banco 594 ÷ 18 = 33 × 1,000/1,100 = 30 + pago real 1,500 ÷ 18 = 83.33
 *    ⇒ 113.33. Σ 145.70 (0.0.65: 292.37) ⇒ saldo 3,501.35 + 146.67 =
 *    3,648.02 ⇒ 2,590.09 / 1,057.93.
 *  - XB-DOS: #507 0 (sin gasto; 0.0.65: 322.48 de provisión); #503 16.66;
 *    #505 pago real 3,000 ÷ 18 = 166.67 (0.0.65: 150 de provisión); #514
 *    banco 945 ÷ 18 = 52.50 × 1,000/1,050 = 50. Σ 233.33 (0.0.65: 589.14)
 *    ⇒ saldo 3,570.86 + 355.81 = 3,926.67 ⇒ 1,963.34 / 1,963.33.
 */
const REPARTO_0074 = {
  [AV]: {
    comisiones_venta_usd: 145.7,
    saldo_disponible_usd: 3648.02,
    reparto: [
      [MAU, 2590.09],
      [ACC, 1057.93],
    ],
    vuelos: [
      ['v-1', 15.7, 0],
      [V3, 16.67, 0],
      [V6, 113.33, 83.33],
    ],
  },
  [AV2]: {
    comisiones_venta_usd: 233.33,
    saldo_disponible_usd: 3926.67,
    reparto: [
      [MAU, 1963.34],
      [ACC, 1963.33],
    ],
    vuelos: [
      [V7, 0, 0],
      [V3, 16.66, 0],
      [V5, 166.67, 166.67],
      ['v-14', 50, 0],
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

/**
 * «Otros movimientos» ANTES de la vigencia desde el 0.0.73 (invariante 58:
 * sin gasto real no hay provisión). Hasta el 0.0.72 (0.0.64 = 0.0.65 =
 * 0.0.66) los vuelos sin gasto real llevaban la PROVISIÓN por lo cobrado:
 * #507 [5467.97, 5467.97, 0], #501 [4600, 3450, 1150], #503 [1800, 2430.01,
 * −630.01] y #513 [1440, 1926, −486]; los demás no cambian (#505 y #506
 * tienen gasto real; #504 y #514 no tienen comisión del vendedor). El 0.0.74
 * no lo mueve: antes de la vigencia VuelaTour paga el gasto real.
 */
const OM_ANTES: Record<number, Array<number | null>> = {
  507: [5467.97, null, 5467.97],
  501: [4600, 1850, 2750],
  503: [1800, 630.01, 1169.99],
  504: [null, 900, -900],
  505: [2700, 3000, -300],
  506: [1800, 2094, -294],
  513: [1440, 486, 954],
  514: [900, 945, -45],
};

/**
 * «Otros movimientos» con la vigencia default en el 0.0.74: [ingreso,
 * egreso, remanente] por folio. Respecto al 0.0.73 solo cambia el #505: su
 * pago real (3,000) lo carga XB-DOS en COMISIONES y la pestaña lo trae «a
 * cargo del avión» con egreso $0.00 (0.0.73: egresaba el exceso sobre la
 * provisión, 300 ⇒ [2700, 300, 2400]). El #506 ya egresaba $0.00 del
 * vendedor (su pago era menor que la provisión): sigue [1800, 54, 1746].
 */
const OM_0074: Record<number, Array<number | null>> = {
  507: [5467.97, null, 5467.97],
  501: [4600, 1536.1, 3063.9],
  503: [1800, 30, 1770],
  504: [null, 900, -900],
  505: [2700, 0, 2700],
  506: [1800, 54, 1746],
  513: [1440, 36, 1404],
  514: [900, 45, 855],
};

/** Los dos pagos reales de `mundoCierre()` (#505 y #506), en MXN. */
const PAGOS_REALES = { 505: 3000, 506: 1500 } as const;

/**
 * Bloque VUELATOUR (empresa) «0.0.74»: participación = 1,963.33 (XB-DOS,
 * 50 %) + 1,148.65 (XB-TST, 29 %) = 3,111.98; ingresos = lo cobrado a los
 * clientes (sin cambio); egresos = los del 0.0.73 (170.85) − el exceso del
 * #505 que ya no egresa (300 ÷ 18 = 16.67) = 154.18; resultado = 3,111.98 +
 * 1,032.48 − 154.18 − 38.72 = 3,951.56. Desde el 0.0.98 (invariante 96) la
 * parte de XB-DOS es 1,963.34 ⇒ participación 3,111.99 y resultado 3,951.57.
 * Desde el 0.0.112 (invariante 112) el RESULTADO suma además la utilidad
 * del libro EXTERNOS de este mundo (fila EXTERNOS del RESUMEN: ganancia
 * 9,000 MXN ÷ K 18 = 500 USD) ⇒ 4,451.57.
 */
const EXTERNOS_USD = 500;
const EMPRESA_0074 = {
  participacion_usd: 3111.99,
  ingresos_propios_usd: 1032.48,
  pagos_vendedor_usd: 154.18,
  otros_gastos_empresa_usd: 38.72,
  resultado_usd: 3951.57 + EXTERNOS_USD,
};

const MATRICULAS = ['XB-TST', 'XB-DOS'] as const;

/**
 * El bloque sin la llave del 0.0.75 (13-oct-2026, invariante 67: la línea
 * «(+) OTROS INGRESOS USD», 0 en este mundo sin ingresos asignados): el
 * bloque CONGELADO de antes. Aparte se prueba que vale 0 y va al final.
 */
function sinOtrosIngresosAvion(
  b: BalanceAvionPayload['balance'],
): Record<string, unknown> {
  const resto: Record<string, unknown> = sinCascadaPesos(b);
  expect(resto.otros_ingresos_avion_usd).toBe(0);
  delete resto.otros_ingresos_avion_usd;
  // RESERVA DE OVERHAUL INFORMATIVA (0.0.98, invariante 96): ADITIVA y no
  // resta de nada; sus números los prueba
  // `aircraft-balance.service.reserva.spec`.
  for (const k of Object.keys(resto))
    if (k.startsWith('reserva_overhaul_')) delete resto[k];
  return resto;
}

/**
 * El bloque sin la cascada EN PESOS del 0.0.94 (invariante 92: las llaves
 * `*_mxn` del bloque y `monto_mxn` de cada socio, ADITIVAS): lo de antes
 * sale intacto. Sus números los prueba `aircraft-balance.service.pesos.spec`.
 */
function sinCascadaPesos(
  b: BalanceAvionPayload['balance'],
): Record<string, unknown> {
  const resto: Record<string, unknown> = { ...b };
  for (const k of Object.keys(resto)) {
    if (k.endsWith('_mxn')) delete resto[k];
  }
  resto.socios = b.socios.map((s) => {
    const c: Record<string, unknown> = { ...s };
    delete c.monto_mxn;
    // Invariante 99 (20-oct-2026): la reserva por socio, ADITIVA; sus
    // números los prueba `aircraft-balance.service.reserva.spec`.
    delete c.utilidad_usd;
    delete c.utilidad_mxn;
    delete c.reserva_usd;
    delete c.reserva_mxn;
    delete c.descuenta_reserva;
    // Invariante 100 (21-oct-2026): lo entregado / por entregar por socio,
    // ADITIVO (las dos Σ del bloque terminan en `_mxn` y ya salieron); sus
    // números los prueba `aircraft-balance.service.entregas-socios.spec`.
    delete c.entregado_mxn;
    delete c.entregado_usd;
    delete c.entregas;
    delete c.por_entregar_mxn;
    return c;
  });
  return resto;
}

/** El bloque sin las dos llaves del 0.0.66 (las de la cascada del general). */
function sinLlavesNuevas(
  b: BalanceAvionPayload['balance'],
): Record<string, unknown> {
  const resto = sinOtrosIngresosAvion(b);
  delete resto.comisiones_usd;
  delete resto.utilidad_antes_comisiones_usd;
  return resto;
}
const ID_DE = { 'XB-TST': AV, 'XB-DOS': AV2 } as const;

describe('Utilidad cobrada por avión: CONGELADA en el 0.0.74 (pago REAL del vendedor)', () => {
  it('libro INDIVIDUAL de cada avión: cascada y socios al centavo; las dos llaves del 0.0.66 van AL FINAL del bloque', async () => {
    for (const m of MATRICULAS) {
      const b = (await libro(ID_DE[m])).balance;
      expect(sinLlavesNuevas(b)).toEqual(BALANCE_0074[m]);
      // … seguidas por la del 0.0.75 (invariante 67), la ÚLTIMA.
      expect(Object.keys(b).slice(-3)).toEqual([
        'comisiones_usd',
        'utilidad_antes_comisiones_usd',
        'otros_ingresos_avion_usd',
      ]);
    }
  });

  it('GENERAL: el bloque de cada avión es el MISMO de su libro individual', async () => {
    const g = await general();
    for (const m of MATRICULAS) {
      const b = bloqueDe(g, m);
      expect(b).toEqual((await libro(ID_DE[m])).balance);
      expect(sinLlavesNuevas(b)).toEqual(BALANCE_0074[m]);
    }
  });

  it('reparto a socios: comisiones, saldo, montos y detalle por vuelo (total y parte REAL del vendedor) al centavo', async () => {
    const r = await reparto();
    for (const a of r.aviones) {
      const congelado =
        REPARTO_0074[a.aeronave.id as keyof typeof REPARTO_0074];
      expect({
        comisiones_venta_usd: a.ingresos.comisiones_venta_usd,
        saldo_disponible_usd: a.saldo_disponible_usd,
        reparto: a.reparto.map((x) => [x.socio_id, x.monto_usd]),
        vuelos: a.detalle.vuelos.map((v) => [
          v.id,
          v.comisiones_avion_usd,
          v.comision_vendedor_real_usd,
        ]),
      }).toEqual(congelado);
      for (const v of a.detalle.vuelos) {
        expect([v.id, v.comision_vendedor_prov_usd]).toEqual([v.id, 0]);
      }
    }
  });

  it('RESUMEN del general: conserva su columna COMISIONES MXN (banco + pagos reales) y su ganancia', async () => {
    const g = await general();
    // XB-DOS: 300 (#503) + 3,000 (#505) + 900 (#514) = 4,200; XB-TST: 313.90
    // + 300.01 + 540 + 1,500 + 450 = 3,103.91. La ganancia sube respecto al
    // 0.0.65 lo que restaban las provisiones (10,267.97 − 4,200 = 6,067.97 y
    // 5,903.91 − 3,103.91 = 2,800).
    expect(
      g.resumen.map((r) => [r.matricula, r.comisiones_mxn, r.ganancia_mxn]),
    ).toEqual([
      ['XB-DOS', 4200, r2(63400.99 + 6067.97)],
      ['XB-TST', 3103.91, r2(85096.09 + 2800)],
      ['EXTERNOS', 0, 9000],
    ]);
    expect([
      g.resumen_totales.comisiones_mxn,
      g.resumen_totales.ganancia_mxn,
    ]).toEqual([7303.91, 166365.05]);
    // Totales de la flota: la parte real del vendedor == Σ pagos reales.
    expect(g.consolidado.totales.comision_vendedor_real_mxn).toBe(
      PAGOS_REALES[505] + PAGOS_REALES[506],
    );
    expect(g.consolidado.totales.comision_vendedor_prov_mxn).toBe(0);
  });

  it('ANTES de la vigencia con los pagos como «(VuelaTour)»: el bloque del 0.0.64, SIN las llaves nuevas (ni en las filas: solo la bandera raíz)', async () => {
    const mundoVt = aVuelatour(mundoCierre());
    const g = await general(POSTERIOR, mundoVt);
    for (const m of MATRICULAS) {
      const ind = await libro(ID_DE[m], POSTERIOR, mundoVt);
      expect(sinOtrosIngresosAvion(ind.balance)).toEqual(BALANCE_ANTES[m]);
      expect('comisiones_usd' in ind.balance).toBe(false);
      expect('utilidad_antes_comisiones_usd' in ind.balance).toBe(false);
      expect(sinOtrosIngresosAvion(bloqueDe(g, m))).toEqual(BALANCE_ANTES[m]);
      for (const v of ind.vuelos) {
        expect([v.folio, 'comision_vendedor_real_mxn' in v]).toEqual([
          v.folio,
          false,
        ]);
        expect([v.folio, 'comision_vendedor_real_pagos' in v]).toEqual([
          v.folio,
          false,
        ]);
      }
      expect('comision_vendedor_real_mxn' in ind.totales).toBe(false);
      expect(ind.comision_vendedor_solo_gasto_real).toBe(true);
      expect(ind.pendientes.some((x) => x.includes('sin pago capturado'))).toBe(
        false,
      );
    }
  });

  it('ANTES de la vigencia con los pagos como «(avión)» (13-oct-2026): los aviones SÍ los cargan — las llaves nacen solo en las filas que absorben (banco 0) y la cascada lleva `comisiones_usd` = el pago', async () => {
    const g = await general(POSTERIOR);
    const fila = (matricula: string, vueloId: string) =>
      g.aviones
        .find((a) => a.matricula === matricula)!
        .vuelos.find((v) => v.vuelo_id === vueloId)!;
    const f505 = fila('XB-DOS', V5);
    expect([
      f505.comision_banco_avion_mxn,
      f505.comision_vendedor_real_mxn,
      f505.comision_vendedor_real_pagos,
      f505.comisiones_mxn,
    ]).toEqual([0, 3000, 1, 3000]);
    const f506 = fila('XB-TST', V6);
    expect([
      f506.comision_banco_avion_mxn,
      f506.comision_vendedor_real_mxn,
      f506.comisiones_mxn,
    ]).toEqual([0, 1500, 1500]);
    // Las filas que no absorben, byte a byte (sin llaves).
    expect('comisiones_mxn' in fila('XB-DOS', V7)).toBe(false);
    expect('comisiones_mxn' in fila('XB-TST', 'v-1')).toBe(false);
    // Cascada: «antes de comisiones» − COMISIONES == utilidad antes, y
    // COMISIONES = el pago ÷ K (3,000 ÷ 18 y 1,500 ÷ 18).
    const dos = bloqueDe(g, 'XB-DOS');
    expect(dos.comisiones_usd).toBe(166.67);
    expect(dos.utilidad_antes_comisiones_usd).toBe(
      BALANCE_ANTES['XB-DOS'].utilidad_antes_usd,
    );
    expect(
      r2((dos.utilidad_antes_comisiones_usd ?? 0) - (dos.comisiones_usd ?? 0)),
    ).toBe(dos.utilidad_antes_usd);
    const tst = bloqueDe(g, 'XB-TST');
    expect(tst.comisiones_usd).toBe(83.33);
    // El reparto (mismo mes, misma regla): la misma cifra por avión.
    const r = await reparto(POSTERIOR);
    expect(
      r.aviones.find((a) => a.aeronave.id === AV2)!.ingresos
        .comisiones_venta_usd,
    ).toBe(166.67);
    expect(
      r.aviones.find((a) => a.aeronave.id === AV)!.ingresos
        .comisiones_venta_usd,
    ).toBe(83.33);
  });
});

describe('`balance.comisiones_usd` — la MISMA cifra que el reparto (fuente única)', () => {
  it('XB-DOS: == `ingresos.comisiones_venta_usd` del reparto al centavo (Σ por vuelo de `comisionesDelVuelo(...).total_usd`)', async () => {
    const b = (await libro(AV2)).balance;
    const r = await reparto();
    const dos = r.aviones.find((a) => a.aeronave.id === AV2)!;
    expect(b.comisiones_usd).toBe(233.33);
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

  it('XB-TST: el reparto + la comisión bancaria del anticipo del #513 CONFIRMADO (el balance cuenta su cobro; el reparto no lee el vuelo): 145.70 + 25.00', async () => {
    const p = await libro(AV);
    const r = await reparto();
    const tst = r.aviones.find((a) => a.aeronave.id === AV)!;
    expect(tst.detalle.vuelos.some((v) => v.id === V13)).toBe(false);
    // 486 ÷ 18 = 27 USD × 1,000/1,080 = 25.00 (comisión bancaria del anticipo).
    const anticipo = p.vuelos.find((v) => v.vuelo_id === V13)!;
    expect(anticipo.comision_banco_avion_mxn).toBe(450);
    expect(p.balance.comisiones_usd).toBe(170.7);
    expect(
      r2((p.balance.comisiones_usd ?? 0) - tst.ingresos.comisiones_venta_usd),
    ).toBe(25);
  });

  it('la cifra del vendedor del reparto × K == `comision_vendedor_real_mxn` de la fila del libro (#505 y #506)', async () => {
    const r = await reparto();
    const g = await general();
    for (const [vueloId, avion] of [
      [V5, AV2],
      [V6, AV],
    ] as const) {
      const v = r.aviones
        .find((a) => a.aeronave.id === avion)!
        .detalle.vuelos.find((x) => x.id === vueloId)!;
      const fila = g.aviones
        .flatMap((a) => a.vuelos)
        .find((x) => x.vuelo_id === vueloId)!;
      expect(
        Math.abs(
          (v.comision_vendedor_real_usd ?? 0) * (fila.tc_venta ?? 0) -
            (fila.comision_vendedor_real_mxn ?? 0),
        ),
      ).toBeLessThan(0.1);
    }
  });

  it('cascada del general: «antes de comisiones» − COMISIONES == `utilidad_antes_usd` al centavo (la fórmula de pyservices) y «antes de comisiones» no se mueve con la regla', async () => {
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
    // XB-DOS: 3,926.67 + 233.33 = 4,160.00 — los 4,160.00 de la regla
    // anterior al centavo desde el 0.0.98 (invariante 96): la ganancia USD
    // de la fila ya resta la comisión del reparto TAL CUAL (#503: 16.66).
    // Hasta el 0.0.97 era 4,159.99 (la fila redondeaba su ganancia neta).
    expect(bloqueDe(g, 'XB-DOS').utilidad_antes_comisiones_usd).toBe(4160);
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
 * restó en pesos ÷ el T.C. de su ganancia (jamás un pago del vendedor que no
 * llegó a pesos); sin ganancia USD, nada.
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
    // 16.66 (#503) + 166.67 (#505, pago real) + 50 (#514).
    expect(bloqueDe(g, 'XB-DOS').comisiones_usd).toBe(233.33);
    expect(bloqueDe(g, 'XB-DOS').comisiones_usd).toBe(
      dos.ingresos.comisiones_venta_usd,
    );
    // 16.67 (#503) + 113.33 (#506) del reparto + 25.00 del anticipo del #513.
    expect(bloqueDe(g, 'XB-TST').comisiones_usd).toBe(155);
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

  it('vuelo SIN K (#521) sin gasto real: suma lo que la fila RESTÓ —su parte de la comisión bancaria, en pesos ÷ el T.C. de su ganancia—; el balance avisa el pendiente de captura y «antes de comisiones» no se mueve', async () => {
    const mundo = conVueloSinK(mundoCierre());
    const p = await libro(AV2, undefined, mundo);
    const f = p.vuelos.find((v) => v.vuelo_id === V21)!;
    // 396 × 1,000/1,100 = 360 de banco; sin K la venta no llega a pesos:
    // remanente 0, ganancia −360.
    expect([
      f.comision_banco_avion_mxn,
      f.comision_vendedor_prov_mxn,
      f.comision_vendedor_real_mxn,
      f.comisiones_mxn,
      f.remanente_mxn,
      f.ganancia_mxn,
    ]).toEqual([360, 0, 0, 360, 0, -360]);
    expect(
      p.pendientes.some(
        (x) =>
          x.includes('#521') &&
          x.includes(
            'comisión del vendedor cotizada ($100.00 USD) sin pago capturado',
          ),
      ),
    ).toBe(true);
    // La ganancia USD de la fila: −360 ÷ el T.C. promedio del libro (sin K
    // ni T.C. de costos) = −20.29; restó 20.29 USD de comisiones.
    expect(f.tc_costos).toBeNull();
    expect(f.ganancia_usd).toBe(-20.29);
    expect(p.balance.comisiones_usd).toBe(r2(233.33 + 20.29));
    expect(p.balance.utilidad_antes_comisiones_usd).toBe(4160);
    expect(
      r2(
        (p.balance.utilidad_antes_comisiones_usd ?? NaN) -
          (p.balance.comisiones_usd ?? 0),
      ),
    ).toBe(p.balance.utilidad_antes_usd);
    // El reparto: solo la bancaria (396 ÷ 18 = 22 × 1,000/1,100 = 20).
    const r = await reparto(undefined, mundo);
    const dos = r.aviones.find((a) => a.aeronave.id === AV2)!;
    expect(
      dos.detalle.vuelos.find((v) => v.id === V21)!.comisiones_avion_usd,
    ).toBe(20);
    expect(dos.ingresos.comisiones_venta_usd).toBe(253.33);
  });

  it('«avión sin pesos» (#521 sin K con un pago real de 100 USD sin tc_gasto): el balance no lo resta en pesos (pendiente nuevo), el reparto SÍ en USD y la pestaña lo trae «a cargo del avión» con $0.00 SIN cifra — nunca dos veces', async () => {
    const base = conVueloSinK(mundoCierre());
    const mundo: Mundo = {
      ...base,
      gasto: [
        ...base.gasto,
        gastoComision(
          'g-com-521',
          100,
          {
            vuelo_id: V21,
            aeronave_id: AV2,
            vuelo: { folio: 521, aeronave_id: AV2 },
            moneda: 'USD',
            tc_gasto: null,
            fecha_gasto: '2026-09-29',
          },
          AVION,
        ),
      ],
    };
    const p = await libro(AV2, undefined, mundo);
    const f = p.vuelos.find((v) => v.vuelo_id === V21)!;
    expect([
      f.comision_vendedor_real_mxn,
      f.comision_vendedor_real_pagos,
      f.comisiones_mxn,
    ]).toEqual([0, 1, 360]);
    expect(f.comisiones_detalle).toContain(
      'Comisión vendedor (Sin K) · $100.00 USD sin T.C. — no suma en pesos',
    );
    expect(
      p.pendientes.some(
        (x) =>
          x.includes('#521') &&
          x.endsWith(
            ': pago al vendedor «Comisión del vendedor (avión)» en USD sin T.C. (ni tc_gasto ni T.C. de venta) — no entra a COMISIONES en pesos; en el reparto sí resta en USD (captura el T.C. del gasto o el de la cotización)',
          ),
      ),
    ).toBe(true);
    // `comisiones_usd` = lo que la fila RESTÓ (no los 100 USD del pago).
    expect(p.balance.comisiones_usd).toBe(r2(233.33 + 20.29));
    // El reparto SÍ lo resta en USD: 20 + 100.
    const r = await reparto(undefined, mundo);
    const dos = r.aviones.find((a) => a.aeronave.id === AV2)!;
    expect(
      dos.detalle.vuelos.find((v) => v.id === V21)!.comision_vendedor_real_usd,
    ).toBe(100);
    expect(dos.ingresos.comisiones_venta_usd).toBe(353.33);
    // La pestaña: egreso $0.00 «a cargo del avión» sin cifra en pesos.
    const g = await general(undefined, mundo);
    const om = omDe(g, 521);
    expect(`${om.concepto_egreso ?? ''}\n${om.nota_egreso ?? ''}`).toContain(
      'pago comisión vendedor (Sin K) · gasto real · a cargo del avión XB-DOS (sin T.C. no entra en pesos a su columna COMISIONES; resta en USD en su reparto)',
    );
    // Sin K la comisión cobrada no llega a pesos (ingreso vacío) y el único
    // egreso es la parte VuelaTour de la bancaria (396 − 360): el pago al
    // vendedor egresa $0.00.
    expect([om.ingreso_mxn, om.egreso_mxn, om.remanente_mxn]).toEqual([
      null,
      36,
      -36,
    ]);
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

describe('«Otros movimientos» con el pago REAL del vendedor (API 0.0.74, invariante 61)', () => {
  it('ninguna fila trae la línea de INGRESO «a cargo del avión» del 0.0.65 ni «cubierto por» del 0.0.66: el «a cargo del avión» de hoy es solo el EGRESO $0.00 de un pago real', async () => {
    const g = await general();
    const ingresos = [
      ...g.consolidado.otros_movimientos!.filas,
      ...g.consolidado.otros_movimientos!.filas_sueltas,
    ]
      .flatMap((f) => [f.concepto_ingreso, f.nota_ingreso])
      .filter(Boolean)
      .join('\n');
    expect(ingresos).not.toMatch(/a cargo del avi[oó]n/);
    expect(textoOm(g)).not.toMatch(/regla sep-2026|cubierto por/);
    expect(textoOm(g)).not.toMatch(/PROVISI[OÓ]N/);
  });

  it('caso del cliente (#507, $5,467.97) SIN gasto real: el ingreso cobrado aparece UNA vez, sin egreso del vendedor, y el avión tampoco resta nada (pendiente de captura)', async () => {
    const g = await general();
    const om = omDe(g, 507);
    expect(om.concepto_ingreso).toBe('comisión vendedor (Pablo Canales)');
    expect(om.ingreso_mxn).toBe(5467.97);
    expect(om.fecha_ingreso).toBe('2026-09-04');
    expect(om.concepto_egreso).toBeNull();
    expect(om.egreso_mxn).toBeNull();
    expect(om.fecha_egreso).toBeNull();
    expect(om.remanente_mxn).toBe(om.ingreso_mxn);
    const fila = g.aviones
      .find((a) => a.matricula === 'XB-DOS')!
      .vuelos.find((v) => v.vuelo_id === V7)!;
    expect([
      fila.comision_vendedor_real_mxn,
      fila.comision_vendedor_prov_mxn,
      fila.comisiones_mxn,
    ]).toEqual([0, 0, null]);
    expect(
      g.aviones
        .find((a) => a.matricula === 'XB-DOS')!
        .pendientes.some(
          (x) =>
            x.includes('#507') &&
            x.includes(
              'comisión del vendedor cotizada ($322.48 USD) sin pago capturado',
            ),
        ),
    ).toBe(true);
  });

  it('#501 (fila colapsada) SIN gasto: ingreso 4,600; egreso = TUAS + parte VuelaTour de la comisión bancaria; sin renglón de pago al vendedor', async () => {
    const om = omDe(await general(), 501);
    expect([om.ingreso_mxn, om.egreso_mxn, om.remanente_mxn]).toEqual(
      OM_0074[501],
    );
    expect(om.concepto_egreso).toBe(
      'TUAs + comisión bancaria · 2 conceptos (ver nota)',
    );
    expect(om.nota_egreso).toBe(
      [
        'tuas pagadas = $1,500.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $36.10',
      ].join('\n'),
    );
  });

  it('MULTI-AVIÓN (#503) SIN gasto: la fila solo trae la parte VuelaTour de la comisión bancaria', async () => {
    const om = omDe(await general(), 503);
    expect([om.ingreso_mxn, om.egreso_mxn, om.remanente_mxn]).toEqual(
      OM_0074[503],
    );
    expect(om.concepto_egreso).toBe(
      'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES)',
    );
  });

  it('pago real MAYOR que lo cobrado (#505, 3,000 vs 2,700): el avión carga los 3,000 EXACTOS en COMISIONES y la pestaña lo trae apareado con egreso $0.00, «excede» y «a cargo del avión XB-DOS ($3,000.00 …)», con la fecha del pago', async () => {
    const g = await general();
    const om = omDe(g, 505);
    expect(om.ingreso_mxn).toBe(2700);
    expect(om.egreso_mxn).toBe(0);
    expect(om.concepto_egreso).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real · excede $300.00 MXN · a cargo del avión XB-DOS ($3,000.00 en su columna COMISIONES)',
    );
    expect(om.fecha_egreso).toBe('2026-09-28');
    expect(om.remanente_mxn).toBe(2700);
    const fila = g.aviones
      .flatMap((a) => a.vuelos)
      .find((v) => v.vuelo_id === V5)!;
    expect([
      fila.comision_vendedor_real_mxn,
      fila.comision_vendedor_real_pagos,
      fila.comisiones_mxn,
    ]).toEqual([PAGOS_REALES[505], 1, 3000]);
    expect(fila.comisiones_detalle).toEqual([
      'Comisión vendedor (Pablo Canales) · $3,000.00 · gasto real',
    ]);
  });

  it('pago real MENOR que lo cobrado (#506, 1,500 vs 1,800): el avión carga los 1,500 y la pestaña dice «parcial: faltan $300.00 MXN · a cargo del avión XB-TST ($1,500.00 …)» por $0.00; solo la parte VuelaTour de la bancaria egresa', async () => {
    const g = await general();
    const om = omDe(g, 506);
    expect([om.ingreso_mxn, om.egreso_mxn, om.remanente_mxn]).toEqual(
      OM_0074[506],
    );
    expect(om.nota_egreso).toBe(
      [
        'pago comisión vendedor (Alex Saab) · gasto real · parcial: faltan $300.00 MXN · a cargo del avión XB-TST ($1,500.00 en su columna COMISIONES) = $0.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $54.00',
      ].join('\n'),
    );
    const fila = g.aviones
      .flatMap((a) => a.vuelos)
      .find((v) => v.vuelo_id === V6)!;
    expect(fila.comision_vendedor_real_mxn).toBe(PAGOS_REALES[506]);
  });

  it('vuelo AÚN NO realizado (#513 CONFIRMADO) y EXTERNO (#504): ningún avión carga el pago al vendedor y, sin gasto real, tampoco egresa en la pestaña', async () => {
    const g = await general();
    const confirmado = omDe(g, 513);
    expect(confirmado.concepto_egreso).toBe(
      'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES)',
    );
    expect(
      `${confirmado.concepto_egreso ?? ''}\n${confirmado.nota_egreso ?? ''}`,
    ).not.toMatch(/pago comisi[oó]n vendedor|PROVISI[OÓ]N/);
    const n = numerosOm(g);
    expect([n[513], n[504], n[514]]).toEqual([
      OM_0074[513],
      OM_0074[504],
      OM_0074[514],
    ]);
    expect(omDe(g, 504).concepto_egreso).toBe('comisión bancaria');
  });

  it('cada fila por vuelo: los números del 0.0.74 (respecto al 0.0.73 solo el #505, cuyo pago ya no egresa en la pestaña)', async () => {
    const n = numerosOm(await general());
    expect(n).toEqual(OM_0074);
    // La línea quitada en el 0.0.66 era la provisión de los aviones: el
    // ingreso bajó eso respecto al 0.0.65.
    expect(r2((OM_0065[507][0] ?? 0) - (n[507][0] ?? 0))).toBe(5467.97);
    expect(r2((OM_0065[503][0] ?? 0) - (n[503][0] ?? 0))).toBe(1800);
  });

  it('ninguna fila lleva la marca de PROVISIÓN (el amarillo de pyservices no se pinta); con gasto real, «a cargo del avión» sin marca y sin «sin TC»', async () => {
    const g = await general();
    const om = g.consolidado.otros_movimientos!;
    const amarillo = (f: BalanceOtroMovimientoFilaPayload) =>
      [f.concepto_egreso, f.nota_egreso].some(
        (t) => t != null && MARCA_AMARILLO_PYSERVICES.test(t),
      );
    const egreso = (folio: number) =>
      `${omDe(g, folio).concepto_egreso ?? ''}\n${omDe(g, folio).nota_egreso ?? ''}`;
    expect(om.filas.filter(amarillo)).toEqual([]);
    expect(om.filas_sueltas.filter(amarillo)).toEqual([]);
    expect(textoOm(g)).not.toMatch(/PROVISI[OÓ]N \(/);
    expect(om.sin_provision_vendedor).toBe(true);
    expect(om.comision_vendedor_solo_gasto_real).toBe(true);
    // #505 y #506 tienen gasto real: la bandera de siempre sigue.
    expect(om.hay_pago_vendedor_real).toBe(true);
    for (const folio of [507, 501, 503, 513]) {
      expect([folio, /pago comisi[oó]n vendedor/.test(egreso(folio))]).toEqual([
        folio,
        false,
      ]);
    }
    for (const folio of [505, 506]) {
      expect([
        folio,
        /pago comisi[oó]n vendedor \([^)]+\) · gasto real.* · a cargo del avión XB-/.test(
          egreso(folio),
        ),
        /\bsin TC\b/.test(egreso(folio)),
        amarillo(omDe(g, folio)),
      ]).toEqual([folio, true, false, false]);
    }
  });

  it('DOS líneas COMISION_VENDEDOR (#522) y pago real de 3,000: el avión carga los 3,000 y la pestaña lo trae UNA sola vez con $0.00; sin pago, ninguna de las dos líneas lleva egreso', async () => {
    const conPago = conVueloDosComisiones(mundoCierre(), 3000);
    const f = (await libro(AV2, undefined, conPago)).vuelos.find(
      (v) => v.vuelo_id === V22,
    )!;
    expect([
      f.comision_vendedor_prov_mxn,
      f.comision_vendedor_real_mxn,
      f.comision_vendedor_real_pagos,
    ]).toEqual([0, 3000, 1]);
    const om = omDe(await general(undefined, conPago), 522);
    expect(om.nota_ingreso).toBe(
      [
        'comisión vendedor (Pablo Canales) = $1,800.00',
        'comisión vendedor (Pablo Canales) = $900.00',
      ].join('\n'),
    );
    expect(om.ingreso_mxn).toBe(2700);
    expect(om.egreso_mxn).toBe(0);
    expect(om.nota_egreso).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real · excede $300.00 MXN · a cargo del avión XB-DOS ($3,000.00 en su columna COMISIONES) = $0.00',
    );
    expect(om.remanente_mxn).toBe(2700);
    const sinPago = omDe(
      await general(undefined, conVueloDosComisiones(mundoCierre(), null)),
      522,
    );
    expect([
      sinPago.ingreso_mxn,
      sinPago.egreso_mxn,
      sinPago.remanente_mxn,
    ]).toEqual([2700, null, 2700]);
    expect(sinPago.concepto_egreso).toBeNull();
    expect(sinPago.nota_egreso).toBeNull();
    expect(sinPago.fecha_egreso).toBeNull();
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

  it('ANTES de la vigencia con los pagos como «(VuelaTour)»: la pestaña de siempre, número por número (VuelaTour paga el gasto real; sin «a cargo del avión» ni PROVISIÓN)', async () => {
    const g = await general(POSTERIOR, aVuelatour(mundoCierre()));
    expect(numerosOm(g)).toEqual(OM_ANTES);
    expect(textoOm(g)).not.toMatch(/cubierto por|a cargo del avi[oó]n/);
    expect(textoOm(g)).not.toMatch(/PROVISI[OÓ]N \(/);
    expect(omDe(g, 505).concepto_egreso).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real · excede $300.00 MXN',
    );
    expect(omDe(g, 506).nota_egreso).toContain(
      'pago comisión vendedor (Alex Saab) · gasto real · parcial: faltan $300.00 MXN = $1,500.00',
    );
  });

  it('ANTES de la vigencia con los pagos como «(avión)» (13-oct-2026): los cargan los aviones también ahí — la pestaña los trae en $0.00 «a cargo del avión» y la comisión bancaria completa sigue siendo de VuelaTour', async () => {
    const g = await general(POSTERIOR);
    expect(numerosOm(g)).toEqual({
      ...OM_ANTES,
      505: [2700, 0, 2700],
      506: [1800, 594, 1206],
    });
    expect(omDe(g, 505).concepto_egreso).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real · excede $300.00 MXN · a cargo del avión XB-DOS ($3,000.00 en su columna COMISIONES)',
    );
    expect(omDe(g, 506).nota_egreso).toContain(
      'pago comisión vendedor (Alex Saab) · gasto real · parcial: faltan $300.00 MXN · a cargo del avión XB-TST ($1,500.00 en su columna COMISIONES) = $0.00',
    );
    // Antes de la vigencia la bancaria NO es del avión: sin «parte VuelaTour».
    expect(omDe(g, 506).nota_egreso).toContain('comisión bancaria = $594.00');
  });
});

/**
 * ESPEC CRUZADO POR ESTADO (invariante 61): por cada pago real, EXACTAMENTE
 * UNO de {Σ `comision_vendedor_real_mxn` de las filas de los libros, el
 * egreso del vendedor en «otros movimientos» (apareado o solo-egreso)} lo
 * lleva, y su suma == el pago (MXN ⇒ al centavo). El dinero total baja
 * EXACTAMENTE el pago, una vez.
 */
describe('Espec cruzado estado × categoría: un pago real cuenta UNA vez, en el avión O en la pestaña', () => {
  const PAGO = 1000;
  const pagoDe = (
    vueloId: string,
    folio: number,
    avion: string | null,
    categoria: typeof VUELATOUR | typeof AVION,
  ) =>
    gastoComision(
      `g-x-${folio}`,
      PAGO,
      {
        vuelo_id: vueloId,
        aeronave_id: avion,
        vuelo: { folio, aeronave_id: avion },
        fecha_gasto: '2026-09-29',
      },
      categoria,
    );
  const conVuelo = (m: Mundo, id: string, cambios: Fila): Mundo => ({
    ...m,
    vuelo: m.vuelo.map((v) => (v.id === id ? { ...v, ...cambios } : v)),
  });
  /**
   * Quién lleva una «(avión)» en cada vuelo (la «(VuelaTour)» la lleva
   * SIEMPRE la pestaña): el avión en su universo —COMPLETADO, o CANCELADO
   * con cobros retenidos— en cualquier fecha, con o sin línea de comisión,
   * con partición consistente o no, con uno o varios aviones; la pestaña
   * fuera de él (no completado, cancelado sin cobros, sin avión).
   */
  const casos: Array<{
    nombre: string;
    mundo: () => Mundo;
    vuelo: [string, number, string | null];
    vigencia?: string;
    quienAvion: 'avion' | 'pestana';
  }> = [
    {
      nombre: 'COMPLETADO de la vigencia con comisión cotizada (#501)',
      mundo: () => mundoCierre(),
      vuelo: ['v-1', 501, AV],
      quienAvion: 'avion',
    },
    {
      nombre: 'COMPLETADO con IVA (#507, K 16.956)',
      mundo: () => mundoCierre(),
      vuelo: [V7, 507, AV2],
      quienAvion: 'avion',
    },
    {
      nombre: 'MULTI-AVIÓN (#503: XB-TST + XB-DOS)',
      mundo: () => mundoCierre(),
      vuelo: [V3, 503, AV],
      quienAvion: 'avion',
    },
    {
      nombre: 'COMPLETADO SIN comisión cotizada (#514: sin línea)',
      mundo: () => mundoCierre(),
      vuelo: [V14, 514, AV2],
      quienAvion: 'avion',
    },
    {
      nombre: 'COMPLETADO con partición INCONSISTENTE (#501)',
      mundo: () => conVuelo(mundoCierre(), 'v-1', { monto_total_usd: 9999 }),
      vuelo: ['v-1', 501, AV],
      quienAvion: 'avion',
    },
    {
      nombre: 'CONFIRMADO con anticipo (#513)',
      mundo: () => mundoCierre(),
      vuelo: [V13, 513, AV],
      quienAvion: 'pestana',
    },
    {
      nombre: 'CANCELADO con dinero retenido (#501)',
      mundo: () => conVuelo(mundoCierre(), 'v-1', { estado: 'CANCELADO' }),
      vuelo: ['v-1', 501, AV],
      quienAvion: 'avion',
    },
    {
      nombre: 'CANCELADO SIN cobros retenidos (#501)',
      mundo: () => {
        const m = conVuelo(mundoCierre(), 'v-1', { estado: 'CANCELADO' });
        return {
          ...m,
          cobro_vuelo: m.cobro_vuelo.filter((c) => c.vuelo_id !== 'v-1'),
        };
      },
      vuelo: ['v-1', 501, AV],
      quienAvion: 'pestana',
    },
    {
      nombre: 'EXTERNO sin avión con comisión cotizada (#504)',
      mundo: () =>
        conVuelo(mundoCierre(), V4, {
          comision_vendedor_usd: 50,
          comision_vendedor_nombre: 'Saab',
          monto_total_usd: 1050,
          monto_total_mxn: 18900,
        }),
      vuelo: [V4, 504, null],
      quienAvion: 'pestana',
    },
    {
      nombre: 'ANTES de la vigencia (#501 con la vigencia el 15-sep)',
      mundo: () => mundoCierre(),
      vuelo: ['v-1', 501, AV],
      vigencia: MITAD,
      quienAvion: 'avion',
    },
  ];

  const realDeVuelo = (g: General, vueloId: string) =>
    r2(
      g.aviones
        .flatMap((a) => a.vuelos)
        .filter((v) => v.vuelo_id === vueloId)
        .reduce((s, v) => s + (v.comision_vendedor_real_mxn ?? 0), 0),
    );
  const egresosOm = (g: General) =>
    r2(
      [
        ...g.consolidado.otros_movimientos!.filas,
        ...g.consolidado.otros_movimientos!.filas_sueltas,
      ].reduce((s, f) => s + (f.egreso_mxn ?? 0), 0),
    );

  for (const caso of casos) {
    for (const categoria of [AVION, VUELATOUR] as const) {
      const quien = categoria === AVION ? caso.quienAvion : 'pestana';
      it(`${caso.nombre} · ${categoria === AVION ? '«(avión)»' : '«(VuelaTour)»'}: lo lleva ${quien === 'avion' ? 'el AVIÓN (COMISIONES; la pestaña egresa $0.00)' : 'VuelaTour en la pestaña (el avión manda 0)'}`, async () => {
        const sin = caso.mundo();
        const gasto = pagoDe(...caso.vuelo, categoria);
        const con: Mundo = { ...sin, gasto: [...sin.gasto, gasto] };
        const gSin = await general(caso.vigencia, sin);
        const gCon = await general(caso.vigencia, con);
        const vueloId = gasto.vuelo_id as string;
        const enAvion = r2(
          realDeVuelo(gCon, vueloId) - realDeVuelo(gSin, vueloId),
        );
        const enPestana = r2(egresosOm(gCon) - egresosOm(gSin));
        expect([enAvion > 0, enPestana > 0]).toEqual(
          quien === 'avion' ? [true, false] : [false, true],
        );
        expect(r2(enAvion + enPestana)).toBe(PAGO);
        // El dinero total baja EXACTAMENTE el pago, una vez.
        expect(r2(dineroTotal(gSin) - dineroTotal(gCon))).toBe(PAGO);
        // Ningún concepto con la marca de PROVISIÓN.
        expect(textoOm(gCon)).not.toMatch(/PROVISI[OÓ]N \(/);
        // Una «(avión)» que nadie carga lo dice en el concepto.
        if (categoria === AVION && quien === 'pestana') {
          expect(textoOm(gCon)).toContain(
            'incluye «Comisión del vendedor (avión)» que ningún avión carga',
          );
        }
      });
    }
  }

  it('el COMPLETADO INCONSISTENTE: la «(VuelaTour)» sale como el solo-egreso de siempre, con su monto; la «(avión)» la carga el avión y la fila es INFORMATIVA ($0.00)', async () => {
    const sin = conVuelo(mundoCierre(), 'v-1', { monto_total_usd: 9999 });
    const g = await general(undefined, {
      ...sin,
      gasto: [...sin.gasto, pagoDe('v-1', 501, AV, VUELATOUR)],
    });
    const om = omDe(g, 501);
    expect(`${om.concepto_egreso ?? ''}\n${om.nota_egreso ?? ''}`).toContain(
      'pago comisión vendedor (Vendedor Uno) · desglose de la cotización inconsistente: sin apareo = $1,000.00',
    );
    const fila = g.aviones
      .flatMap((a) => a.vuelos)
      .find((v) => v.vuelo_id === 'v-1')!;
    expect([
      fila.comision_vendedor_real_mxn,
      fila.comision_vendedor_real_pagos,
    ]).toEqual([0, 0]);
    const gAv = await general(undefined, {
      ...sin,
      gasto: [...sin.gasto, pagoDe('v-1', 501, AV, AVION)],
    });
    const omAv = omDe(gAv, 501);
    expect(
      `${omAv.concepto_egreso ?? ''}\n${omAv.nota_egreso ?? ''}`,
    ).toContain(
      'pago comisión vendedor (Vendedor Uno) · desglose de la cotización inconsistente: sin apareo · a cargo del avión XB-TST ($1,000.00 en su columna COMISIONES) = $0.00',
    );
  });
});

describe('Bloque VUELATOUR (empresa) y conservación del dinero (API 0.0.74)', () => {
  it('el bloque sale de las filas: ingresos = lo cobrado a los clientes; egresos SIN los pagos que cargan los aviones ($0.00 «a cargo del avión»); participación con la utilidad después de los pagos reales', async () => {
    const con = (await general()).empresa!;
    const antes = (await general(POSTERIOR)).empresa!;
    expect({
      participacion_usd: con.participacion_usd,
      ingresos_propios_usd: con.ingresos_propios_usd,
      pagos_vendedor_usd: con.pagos_vendedor_usd,
      otros_gastos_empresa_usd: con.otros_gastos_empresa_usd,
      resultado_usd: con.resultado_usd,
    }).toEqual(EMPRESA_0074);
    expect(con.ingresos_propios_usd).toBe(antes.ingresos_propios_usd);
    expect(con.movimientos_sin_tc).toBe(0);
    // 0.0.112 (invariante 112): el libro EXTERNOS de este mundo entra al
    // bloque con su utilidad (500 USD) y el RESULTADO la suma.
    expect(con.externos?.vuelos).toBe(1);
    expect(con.externos?.utilidad_usd).toBe(EXTERNOS_USD);
    expect(con.resultado_usd).toBe(
      r2(
        (con.participacion_usd ?? 0) +
          (con.ingresos_propios_usd ?? 0) -
          (con.pagos_vendedor_usd ?? 0) -
          (con.otros_gastos_empresa_usd ?? 0) +
          (con.externos?.utilidad_usd ?? 0),
      ),
    );
  });

  it('la nota del bloque dice que la «(VuelaTour)» egresa aquí y la «(avión)» que carga un avión aquí egresa $0.00 (con pagos absorbidos, en cualquier fecha); sin pagos absorbidos, la corta; ninguna habla de provisión', async () => {
    const aCargo =
      'Egresos = pago al vendedor (solo los gastos reales capturados: la «Comisión del vendedor (VuelaTour)» egresa aquí; la «Comisión del vendedor (avión)» que carga un avión en su columna COMISIONES aquí egresa $0.00), TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.';
    const conRegla = (await general()).empresa!.nota;
    expect(conRegla).toContain(aCargo);
    expect(conRegla.toLowerCase()).not.toContain('provisi');
    const siempre =
      'Egresos = pago al vendedor (solo los gastos reales de comisión del vendedor capturados), TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.';
    // Antes de la vigencia: los «(avión)» SÍ se absorben ⇒ la larga; con
    // los mismos pagos como «(VuelaTour)», la corta.
    expect((await general(POSTERIOR)).empresa!.nota).toContain(aCargo);
    const antes = (await general(POSTERIOR, aVuelatour(mundoCierre()))).empresa!
      .nota;
    expect(antes).toContain(siempre);
    expect(antes).not.toContain('que carga un avión');
    // En la vigencia pero SIN pagos reales absorbidos (sin los gastos del
    // #505 y el #506): la nota corta.
    const m = mundoCierre();
    const sinPagos = (
      await general(undefined, {
        ...m,
        gasto: m.gasto.filter((g) => !String(g.id).startsWith('g-com-')),
      })
    ).empresa!.nota;
    expect(sinPagos).toContain(siempre);
    expect(sinPagos).not.toContain('que carga un avión');
  });

  it('`mundoSinFaltante` (sin el pago del #506): sube la participación de la empresa el 29 % de ese pago y los egresos no cambian (ese pago ya egresaba $0.00)', async () => {
    const con = (await general(undefined, mundoSinFaltante())).empresa!;
    // XB-TST: utilidad cobrada 3,960.86 + 1,500 ÷ 18 (83.33) = 4,044.19 ⇒
    // 29 % = 1,172.82 (residuo mayor) ⇒ 1,963.34 (XB-DOS desde el 0.0.98)
    // + 1,172.82.
    expect(con.participacion_usd).toBe(3136.16);
    expect(con.pagos_vendedor_usd).toBe(EMPRESA_0074.pagos_vendedor_usd);
    expect(con.resultado_usd).toBe(3975.74 + EXTERNOS_USD);
  });

  it('conservación: Σ ganancia de los libros + Σ remanente de «otros movimientos» == la regla anterior AL CENTAVO — lo que las filas restan en COMISIONES (banco + pagos absorbidos) es exactamente lo que la pestaña deja de egresar', async () => {
    for (const mundo of [
      mundoCierre(),
      mundoSinFaltante(),
      aVuelatour(mundoCierre()),
    ]) {
      const con = await general(undefined, mundo);
      const antes = await general(POSTERIOR, mundo);
      expect(dineroTotal(con)).toBe(dineroTotal(antes));
      // Lo que las filas restan de MÁS en COMISIONES con la regla (la parte
      // bancaria: la «(avión)» resta en las dos) es lo que la pestaña deja
      // de egresar.
      const comisiones = (g: General) =>
        r2(
          g.consolidado.vuelos.reduce((a, v) => a + (v.comisiones_mxn ?? 0), 0),
        );
      const omRem = (g: General) =>
        r2(
          [
            ...g.consolidado.otros_movimientos!.filas,
            ...g.consolidado.otros_movimientos!.filas_sueltas,
          ].reduce((a, f) => a + (f.remanente_mxn ?? 0), 0),
        );
      expect(r2(omRem(con) - omRem(antes))).toBe(
        r2(comisiones(con) - comisiones(antes)),
      );
    }
    // Cada pago real en EXACTAMENTE un lugar (contrato §I): con los pagos
    // como «(VuelaTour)» ningún avión los lleva y la pestaña los egresa.
    const vt = await general(undefined, aVuelatour(mundoCierre()));
    expect(
      r2(
        vt.aviones
          .flatMap((a) => a.vuelos)
          .reduce((s, v) => s + (v.comision_vendedor_real_mxn ?? 0), 0),
      ),
    ).toBe(0);
    // La diferencia de dinero entre las dos categorías es CERO: el mismo
    // pago, distinto lado.
    expect(dineroTotal(vt)).toBe(dineroTotal(await general()));
    // Los pagos reales de los aviones son EXACTAMENTE los gastos del mes.
    const g = await general();
    expect(
      r2(
        g.aviones
          .flatMap((a) => a.vuelos)
          .reduce((s, v) => s + (v.comision_vendedor_real_mxn ?? 0), 0),
      ),
    ).toBe(PAGOS_REALES[505] + PAGOS_REALES[506]);
    // Quitar un pago real sube el dinero total EXACTAMENTE ese pago.
    expect(
      r2(
        dineroTotal(await general(undefined, mundoSinFaltante())) -
          dineroTotal(g),
      ),
    ).toBe(PAGOS_REALES[506]);
  });
});
