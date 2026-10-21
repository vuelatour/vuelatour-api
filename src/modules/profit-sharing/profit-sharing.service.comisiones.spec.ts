// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  // Etiqueta del T.C. oficial (detalle.vuelos[].tc_oficial).
  fuenteTcLegible: (f: string | null | undefined) => f ?? 'TC oficial',
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

import {
  PAGO_VENDEDOR_AVION_CLAVE_DETALLE,
  PAGO_VENDEDOR_AVION_OTRO_PERIODO_CLAVE_DETALLE,
  PAGO_VENDEDOR_AVION_VUELATOUR_CLAVE_DETALLE,
  PAGO_VENDEDOR_CLAVE_DETALLE,
  ProfitSharingService,
} from './profit-sharing.service';
import { AircraftBalanceService } from '../aircraft/aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { BalanceAvionPayload } from '../pyservices/pyservices.service';
import {
  AV,
  AVION,
  DESDE,
  HASTA,
  V1,
  VUELATOUR,
  fakeSupabase,
  gastoComision,
  mundoCon,
  mundoLibros,
  vuelo2,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';

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
 * REPARTO A SOCIOS — COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65).
 * `compute()` (y con él las utilidades por mes de la cuenta corriente)
 * descuenta por vuelo, desde `comisiones_al_avion_desde`, las MISMAS
 * comisiones que el balance por avión — fuente única `comisionesDelVuelo`,
 * aquí en USD — en `comisiones_venta_usd`, el campo que el PDF/XLSX y el
 * panel ya restan en la cascada del saldo.
 *
 * 13-oct-2026 (API 0.0.74, invariante 61; decisión 3 del lote del cliente
 * ajustada el mismo día: DOS categorías): la parte del VENDEDOR es el pago
 * capturado como «Comisión del vendedor (avión)» — Σ de esos gastos ligados
 * al vuelo (lectura POR VUELO, de cualquier fecha_gasto: cuenta en el MES DEL
 * VUELO), convertidos con tc_gasto ?? K — con el vuelo COMPLETADO o
 * CANCELADO con cobros retenidos, en CUALQUIER fecha (la vigencia ya solo
 * gobierna la parte bancaria). La «Comisión del vendedor (VuelaTour)» nunca
 * resta en el reparto. Sin pago no se resta nada (la provisión de 80 USD
 * murió). Los casos de absorción de la D3 se re-apuntaron a la «(avión)»
 * (`conPagoReal`) con las MISMAS cifras.
 *
 * Mundo de los libros: #501 COMPLETADO de XB-TST (10-sep, K 20), 2,230 USD
 * = 2,000 de tiempo + 100 TUAS + 50 extras + 80 de comisión del vendedor;
 * cobrado 2,000 USD (20,000 MXN con 350 de comisión bancaria + 1,000 USD).
 *  - venta del avión cobrada = round2(2,000 × 2,000/2,230) = 1,793.72;
 *  - banco: 350 ÷ 20 = 17.50 USD × 2,000/2,230 = 15.70;
 *  - SIN gasto real: saldo = 1,793.72 − 15.70 = 1,778.02 (hasta el 0.0.73
 *    restaba además la provisión de 80: 1,698.02); el GAS sin T.C. no
 *    convierte;
 *  - CON un gasto real de 1,600 MXN (÷ K 20 = 80 USD): 1,698.02.
 */

const AV2 = 'av-2';
const V3 = 'v-3';
const MAU = 'u-mau';
const ACC = 'u-acc';
const POSTERIOR = '2026-12-01';
const r2 = (x: number) => Math.round(x * 100) / 100;

type Avion = Awaited<
  ReturnType<ProfitSharingService['compute']>
>['aviones'][number];

/** El mundo de los libros con lo que lee el reparto (avión activo y socios). */
function mundoReparto(extra: Partial<Record<string, Fila[]>> = {}) {
  const m = mundoLibros();
  const base: Record<string, Fila[]> = {
    ...m,
    aeronave: m.aeronave.map((a) => ({ ...a, activa: true })),
    aeronave_socio: [
      {
        aeronave_id: AV,
        socio_id: MAU,
        porcentaje: '71.000',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
      {
        aeronave_id: AV,
        socio_id: ACC,
        porcentaje: '29.000',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
    ],
    usuario: [
      { id: MAU, nombre: 'Mauricio Roque' },
      { id: ACC, nombre: 'Aero Charter Cancun S.A. de C.V.' },
    ],
    reserva_overhaul: [],
  };
  return { ...base, ...extra } as Record<string, Fila[]>;
}

/** T.C. oficial de cualquier día (null ⇒ sin dato, como siempre). */
const tipoCambio = (tcOficial: number | null) => ({
  oficialDetallePara: (dia: string) =>
    Promise.resolve(
      tcOficial == null
        ? null
        : { tc: tcOficial, fecha_dato: dia, fuente: 'OPEN_ER_API' },
    ),
});

function armar(
  mundo: Record<string, Fila[]>,
  vigencia?: string,
  tcOficial: number | null = null,
) {
  const f = fakeSupabase(mundo);
  const selectsCobro: string[] = [];
  // Cada consulta a `gasto`: la lista de métodos y argumentos, en orden.
  const consultasGasto: Array<Array<[string, unknown[]]>> = [];
  const from = (tabla: string) => {
    const q = f.supabase.service.from(tabla);
    if (tabla === 'cobro_vuelo') {
      const original = q.select as (cols?: string) => unknown;
      q.select = (cols?: string) => {
        selectsCobro.push(cols ?? '');
        return original(cols);
      };
    }
    if (tabla === 'gasto') {
      const log: Array<[string, unknown[]]> = [];
      consultasGasto.push(log);
      const proxy: Record<string, unknown> = {};
      for (const [k, fn] of Object.entries(q)) {
        if (typeof fn !== 'function') continue;
        proxy[k] = (...args: unknown[]) => {
          if (k !== 'then') log.push([k, args]);
          const r = (fn as (...a: unknown[]) => unknown)(...args);
          return r === q ? proxy : r;
        };
      }
      return proxy;
    }
    return q;
  };
  const lecturas: Array<[string, string]> = [];
  const config = {
    fecha: (clave: string, porDefecto: string) => {
      lecturas.push([clave, porDefecto]);
      return Promise.resolve(vigencia ?? porDefecto);
    },
  };
  const nada = {} as never;
  const svc = new ProfitSharingService(
    { service: { from } } as unknown as SupabaseService,
    nada,
    tipoCambio(tcOficial) as never,
    nada,
    config as never,
  );
  return { svc, selectsCobro, lecturas, consultasGasto };
}

/** Columnas de la lectura POR VUELO del pago al vendedor (invariante 61). */
const SELECT_VENDEDOR =
  'vuelo_id, categoria, monto, moneda, tc_gasto, fecha_gasto';

/** Las consultas a `gasto` de la lectura POR VUELO (por su select). */
const consultasVendedor = (c: Array<Array<[string, unknown[]]>>) =>
  c.filter((log) =>
    log.some(([m, args]) => m === 'select' && args[0] === SELECT_VENDEDOR),
  );

/** Libro individual del avión (balance) con la misma vigencia y T.C. oficial. */
async function libroBalance(
  mundo: Record<string, Fila[]>,
  vigencia?: string,
  tcOficial: number | null = null,
): Promise<BalanceAvionPayload> {
  const enviados: { individual?: BalanceAvionPayload } = {};
  const balance = new AircraftBalanceService(
    fakeSupabase(mundo).supabase as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        enviados.individual = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    tipoCambio(tcOficial) as never,
    {} as never,
    {
      fecha: (_clave: string, porDefecto: string) =>
        Promise.resolve(vigencia ?? porDefecto),
    } as never,
  );
  await balance.xlsx(AV, DESDE, HASTA);
  return enviados.individual!;
}

/**
 * + vuelos de la vigencia que AÚN NO se realizan (fuera del reparto, que
 * solo lee COMPLETADO y CANCELADO), sin cobros y con comisión del vendedor:
 * #510 COTIZADO (150), #511 RESERVA (100), #512 CONFIRMADO (50); K 18.
 */
function mundoConNoRealizados(): Record<string, Fila[]> {
  const m = mundoReparto();
  const pendiente = (
    id: string,
    folio: number,
    estado: string,
    dia: string,
    comision: number,
  ): Fila =>
    vuelo2({
      id,
      folio,
      estado,
      fecha_vuelo: `2026-09-${dia}T15:00:00+00:00`,
      comision_vendedor_usd: comision,
      comision_vendedor_nombre: 'Saab',
      monto_total_usd: 1000 + comision,
      monto_total_mxn: (1000 + comision) * 18,
    });
  return {
    ...m,
    vuelo: [
      ...m.vuelo,
      pendiente('v-10', 510, 'COTIZADO', '28', 150),
      pendiente('v-11', 511, 'RESERVA', '27', 100),
      pendiente('v-12', 512, 'CONFIRMADO', '26', 50),
    ],
  };
}

async function avion(
  mundo: Record<string, Fila[]>,
  vigencia?: string,
  id: string = AV,
): Promise<Avion> {
  const { svc } = armar(mundo, vigencia);
  const r = await svc.compute({ desde: DESDE, hasta: HASTA });
  const a = r.aviones.find((x) => x.aeronave.id === id);
  if (!a) throw new Error(`sin avión ${id}`);
  return a;
}

/** Rutas (a.b.0.c) donde dos resultados difieren. */
function diferencias(a: unknown, b: unknown, ruta = ''): string[] {
  if (Object.is(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...claves].flatMap((k) =>
      diferencias(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        ruta ? `${ruta}.${k}` : k,
      ),
    );
  }
  return [ruta];
}

/**
 * #501 + un pago real al vendedor (MXN, sin tc_gasto): «Comisión del
 * vendedor (avión)» por default; `VUELATOUR` para la que paga VuelaTour.
 */
const conPagoReal = (
  monto: number,
  extra: Fila = {},
  categoria: typeof VUELATOUR | typeof AVION = AVION,
) =>
  mundoReparto({
    gasto: mundoCon({
      gastos: [gastoComision('g-cv', monto, extra, categoria)],
    }).gasto,
  });

/** Las CUATRO claves EXCLUIDO del pago al vendedor (comparación EXACTA). */
const CLAVES_PAGO_VENDEDOR = new Set([
  PAGO_VENDEDOR_CLAVE_DETALLE,
  PAGO_VENDEDOR_AVION_CLAVE_DETALLE,
  PAGO_VENDEDOR_AVION_OTRO_PERIODO_CLAVE_DETALLE,
  PAGO_VENDEDOR_AVION_VUELATOUR_CLAVE_DETALLE,
]);
/** La fila EXCLUIDO del pago al vendedor del detalle (si la hay). */
const filaPagoVendedor = (a: Avion) =>
  a.detalle.gastos_por_categoria.find((x) =>
    CLAVES_PAGO_VENDEDOR.has(x.categoria),
  );

/** El multi-avión #503 (XB-TST + un tramo de XB-DOS, K 18). */
function mundoMultiAvion(gastos: Fila[] = []): Record<string, Fila[]> {
  const m = mundoReparto();
  const f3 = '2026-09-15T15:00:00+00:00';
  return mundoReparto({
    aeronave: [
      ...m.aeronave,
      {
        ...m.aeronave[0],
        id: AV2,
        matricula: 'XB-DOS',
        activa: true,
      },
    ],
    vuelo: [
      ...m.vuelo,
      vuelo2({
        id: V3,
        folio: 503,
        fecha_vuelo: f3,
        destino_iata: 'MID',
        tiempo_cobrable_hr: 2,
        subtotal_vuelo_usd: 2000,
        comision_vendedor_usd: 100,
        monto_total_usd: 2100,
        monto_total_mxn: 37800,
      }),
    ],
    escala: [
      ...m.escala,
      {
        id: 'e-3a',
        vuelo_id: V3,
        orden: 1,
        aeronave_id: null,
        cancelada_at: null,
        taco_salida: null,
        taco_llegada: null,
        solo_operativa: false,
        es_ferry: false,
        origen_iata: 'CUN',
        destino_iata: 'MID',
      },
      {
        id: 'e-3b',
        vuelo_id: V3,
        orden: 2,
        aeronave_id: AV2,
        cancelada_at: null,
        taco_salida: null,
        taco_llegada: null,
        solo_operativa: false,
        es_ferry: false,
        origen_iata: 'MID',
        destino_iata: 'CUN',
      },
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      {
        id: 'c-4',
        vuelo_id: V3,
        monto: 37800,
        moneda: 'MXN',
        tc_usd_mxn: 18,
        fecha_cobro: '2026-09-15T20:00:00+00:00',
        comision_banco_monto: 630.01,
      },
    ],
    gasto: [...m.gasto, ...gastos],
  });
}

describe('Reparto a socios — COMISIONES a cargo del avión (API 0.0.65; pago REAL del vendedor desde el 0.0.74)', () => {
  it('SIN gasto real: `comisiones_venta_usd` = solo la parte del avión de la comisión bancaria y el saldo SUBE lo que valía la provisión (80 USD)', async () => {
    const a = await avion(mundoReparto());
    expect(a.ingresos.cobrado_usd).toBe(1793.72);
    expect(a.ingresos.comisiones_venta_usd).toBe(15.7);
    // 1,793.72 − 15.70; hasta el 0.0.73: 1,698.02 (− 80 de provisión).
    expect(a.saldo_disponible_usd).toBe(1778.02);
    expect(r2(a.saldo_disponible_usd - 1698.02)).toBe(80);
    const v = a.detalle.vuelos.find((x) => x.id === V1)!;
    expect(v.comisiones_avion_usd).toBe(15.7);
    expect(v.comision_banco_avion_usd).toBe(15.7);
    expect(v.comision_vendedor_prov_usd).toBe(0);
    expect(v.comision_vendedor_real_usd).toBe(0);
    // La regla A sigue: la columna vieja del detalle no se usa.
    expect(v.comision_vendedor_usd).toBe(0);
    // Reparto por residuo mayor sobre el saldo después de comisiones:
    // 177,802 ¢ × 71 % = 126,239.42 ⇒ 126,239; × 29 % = 51,562.58 ⇒ 51,562
    // + el centavo del residuo mayor.
    expect(a.reparto.map((r) => [r.socio_id, r.monto_usd])).toEqual([
      [MAU, 1262.39],
      [ACC, 515.63],
    ]);
  });

  it('CON gasto real de $1,600 MXN (sin tc_gasto ⇒ ÷ K 20 = 80 USD): resta EXACTAMENTE lo pagado; `comision_vendedor_real_usd` 80 y `comision_vendedor_prov_usd` 0; Σ detalle == `comisiones_venta_usd`', async () => {
    const a = await avion(conPagoReal(1600));
    const v = a.detalle.vuelos.find((x) => x.id === V1)!;
    expect([
      v.comisiones_avion_usd,
      v.comision_banco_avion_usd,
      v.comision_vendedor_prov_usd,
      v.comision_vendedor_real_usd,
    ]).toEqual([95.7, 15.7, 0, 80]);
    expect(a.ingresos.comisiones_venta_usd).toBe(95.7);
    expect(a.saldo_disponible_usd).toBe(1698.02);
    expect(a.reparto.map((r) => [r.socio_id, r.monto_usd])).toEqual([
      [MAU, 1205.59],
      [ACC, 492.43],
    ]);
    expect(
      r2(
        a.detalle.vuelos.reduce((s, x) => s + (x.comisiones_avion_usd ?? 0), 0),
      ),
    ).toBe(a.ingresos.comisiones_venta_usd);
    // Con `tc_gasto` propio manda el del gasto: 1,600 ÷ 19.5 = 82.05.
    const conTc = await avion(conPagoReal(1600, { tc_gasto: 19.5 }));
    expect(
      conTc.detalle.vuelos.find((x) => x.id === V1)!.comision_vendedor_real_usd,
    ).toBe(82.05);
    // Un pago en USD resta tal cual.
    const usd = await avion(conPagoReal(75, { moneda: 'USD' }));
    expect(
      usd.detalle.vuelos.find((x) => x.id === V1)!.comision_vendedor_real_usd,
    ).toBe(75);
  });

  it('MES DEL VUELO: un pago capturado en OCTUBRE de un vuelo de septiembre cuenta en el reparto de SEPTIEMBRE y NO en el de octubre (ahí sale solo como EXCLUIDO «vuelo de otro periodo»)', async () => {
    const mundo = conPagoReal(1600, { fecha_gasto: '2026-10-05' });
    const { svc } = armar(mundo);
    const sep = (await svc.compute({ desde: DESDE, hasta: HASTA })).aviones[0];
    expect(sep.ingresos.comisiones_venta_usd).toBe(95.7);
    expect(sep.saldo_disponible_usd).toBe(1698.02);
    // En septiembre el gasto no llega por fecha_gasto: no hay fila EXCLUIDO.
    expect(filaPagoVendedor(sep)).toBeUndefined();
    const oct = (
      await svc.compute({ desde: '2026-10-01', hasta: '2026-10-31' })
    ).aviones[0];
    expect(oct.ingresos.comisiones_venta_usd).toBe(0);
    expect(oct.gastos.directos_usd).toBe(0);
    expect(oct.gastos.indirectos_usd).toBe(0);
    expect(oct.gastos.permisos_usd).toBe(0);
    expect(filaPagoVendedor(oct)).toMatchObject({
      categoria: PAGO_VENDEDOR_AVION_OTRO_PERIODO_CLAVE_DETALLE,
      grupo: 'EXCLUIDO',
    });
  });

  it('la lectura POR VUELO va por `.in(vuelo_id, lote)` + `.order(id)` + `.range` SIN filtro de categoría ni de fecha (invariante 31: 22P02) y `fetchGastos` por fecha NO lo suma (directos/indirectos/permisos y T.C. oficial iguales); la fila EXCLUIDO dice «a cargo del avión»', async () => {
    const con = armar(conPagoReal(1600, { tc_gasto: 20 }));
    const rCon = await con.svc.compute({ desde: DESDE, hasta: HASTA });
    const vend = consultasVendedor(con.consultasGasto);
    expect(vend).toHaveLength(1);
    const metodos = vend[0].map(([m]) => m);
    expect(metodos).toEqual(['select', 'in', 'order', 'range']);
    expect(vend[0][1]).toEqual(['in', ['vuelo_id', [V1]]]);
    expect(vend[0][2]).toEqual(['order', ['id', { ascending: true }]]);
    expect(vend[0][3]).toEqual(['range', [0, 999]]);
    for (const [m, args] of vend[0]) {
      expect([m, args[0]]).not.toEqual(['eq', 'categoria']);
      expect(['gte', 'lte', 'eq', 'neq', 'not', 'or']).not.toContain(m);
    }
    // El eje fecha_gasto no lo suma: los agregados son los del mundo sin él.
    const rSin = await armar(mundoReparto()).svc.compute({
      desde: DESDE,
      hasta: HASTA,
    });
    const a = rCon.aviones[0];
    const b = rSin.aviones[0];
    expect([
      a.gastos.directos_usd,
      a.gastos.indirectos_usd,
      a.gastos.permisos_usd,
      a.gastos.gastos_tc_oficial,
      a.gastos.gastos_sin_tc_count,
      a.gastos.gastos_sin_tc_mxn,
    ]).toEqual([
      b.gastos.directos_usd,
      b.gastos.indirectos_usd,
      b.gastos.permisos_usd,
      b.gastos.gastos_tc_oficial,
      b.gastos.gastos_sin_tc_count,
      b.gastos.gastos_sin_tc_mxn,
    ]);
    expect(filaPagoVendedor(a)).toMatchObject({
      categoria: PAGO_VENDEDOR_AVION_CLAVE_DETALLE,
      grupo: 'EXCLUIDO',
      usd: 80,
    });
    // La diferencia de saldo es SOLO el pago real (por la lectura por vuelo).
    expect(r2(b.saldo_disponible_usd - a.saldo_disponible_usd)).toBe(80);
  });

  it('lotes de 200 ids y páginas de 1,000 (PostgREST corta en silencio): 450 vuelos ⇒ 3 lotes; 1,001 gastos de un vuelo ⇒ 2 páginas, y el pago de la fila 1,001 NO se pierde', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `v-x${i}`);
    const gastos: Fila[] = Array.from({ length: 1001 }, (_, i) => ({
      id: `g-${String(i).padStart(5, '0')}`,
      vuelo_id: 'v-x0',
      // Las DOS categorías (13-oct-2026): la «(VuelaTour)» en la 1.ª página
      // y la «(avión)» en la fila 1,001 (2.ª página).
      categoria:
        i === 1000
          ? 'COMISION_VENDEDOR_AVION'
          : i === 0
            ? 'COMISION_VENDEDOR'
            : 'OPERACIONES',
      monto: 10,
      moneda: 'MXN',
      tc_gasto: null,
      fecha_gasto: '2026-09-10',
    }));
    const { svc, consultasGasto } = armar(mundoReparto({ gasto: gastos }));
    const mapa = await (
      svc as unknown as {
        fetchGastosVendedorDeVuelos: (
          ids: string[],
        ) => Promise<Map<string, Fila[]>>;
      }
    ).fetchGastosVendedorDeVuelos(ids);
    // Solo las dos categorías (la UNIÓN): el mapa no guarda los OPERACIONES.
    expect([...mapa.keys()]).toEqual(['v-x0']);
    expect(mapa.get('v-x0')!.map((g) => g.categoria)).toEqual([
      'COMISION_VENDEDOR',
      'COMISION_VENDEDOR_AVION',
    ]);
    const llamadas = consultasVendedor(consultasGasto);
    const lotes = llamadas.map(
      (log) => (log.find(([m]) => m === 'in')![1][1] as string[]).length,
    );
    const rangos = llamadas.map((log) => log.find(([m]) => m === 'range')![1]);
    expect(lotes).toEqual([200, 200, 200, 50]);
    expect(rangos).toEqual([
      [0, 999],
      [1000, 1999],
      [0, 999],
      [0, 999],
    ]);
  });

  it('ANTES de la vigencia: el reparto de siempre (solo cambian comisiones, saldo, montos de los socios y las llaves nuevas del detalle)', async () => {
    const { svc: antes } = armar(mundoReparto(), POSTERIOR);
    const { svc: con } = armar(mundoReparto());
    const rAntes = await antes.compute({ desde: DESDE, hasta: HASTA });
    const rCon = await con.compute({ desde: DESDE, hasta: HASTA });
    const a = rAntes.aviones[0];
    expect(a.ingresos.comisiones_venta_usd).toBe(0);
    expect(a.saldo_disponible_usd).toBe(1793.72);
    expect('comisiones_avion_usd' in a.detalle.vuelos[0]).toBe(false);
    expect('comision_vendedor_real_usd' in a.detalle.vuelos[0]).toBe(false);
    expect(diferencias(rAntes, rCon).sort()).toEqual(
      [
        'aviones.0.detalle.vuelos.0.comision_banco_avion_usd',
        'aviones.0.detalle.vuelos.0.comision_vendedor_prov_usd',
        'aviones.0.detalle.vuelos.0.comision_vendedor_real_usd',
        'aviones.0.detalle.vuelos.0.comisiones_avion_usd',
        'aviones.0.ingresos.comisiones_venta_usd',
        'aviones.0.reparto.0.monto_usd',
        'aviones.0.reparto.1.monto_usd',
        'aviones.0.saldo_disponible_usd',
        // API 0.0.94 (invariante 92): lo mismo EN PESOS (aditivo).
        'aviones.0.ingresos.comisiones_venta_mxn',
        'aviones.0.reparto.0.monto_mxn',
        'aviones.0.reparto.1.monto_mxn',
        'aviones.0.saldo_disponible_mxn',
        // Invariante 99: la parte de cada socio ANTES de la reserva.
        'aviones.0.reparto.0.utilidad_usd',
        'aviones.0.reparto.0.utilidad_mxn',
        'aviones.0.reparto.1.utilidad_usd',
        'aviones.0.reparto.1.utilidad_mxn',
      ].sort(),
    );
    // Antes de la vigencia una «(VuelaTour)» tampoco resta: la paga VuelaTour.
    const conGasto = (
      await armar(conPagoReal(1600, {}, VUELATOUR), POSTERIOR).svc.compute({
        desde: DESDE,
        hasta: HASTA,
      })
    ).aviones[0];
    expect(conGasto.ingresos.comisiones_venta_usd).toBe(0);
    expect(conGasto.saldo_disponible_usd).toBe(1793.72);
    expect(filaPagoVendedor(conGasto)?.categoria).toBe(
      PAGO_VENDEDOR_CLAVE_DETALLE,
    );
    // Una «(avión)» SÍ: la elección explícita manda en cualquier fecha
    // (13-oct-2026) — solo ella, sin la parte bancaria (que es de la
    // vigencia), y con las llaves del detalle.
    const conAvion = (
      await armar(conPagoReal(1600), POSTERIOR).svc.compute({
        desde: DESDE,
        hasta: HASTA,
      })
    ).aviones[0];
    expect(conAvion.ingresos.comisiones_venta_usd).toBe(80);
    expect(conAvion.saldo_disponible_usd).toBe(r2(1793.72 - 80));
    const v = conAvion.detalle.vuelos.find((x) => x.id === V1)!;
    expect([
      v.comisiones_avion_usd,
      v.comision_banco_avion_usd,
      v.comision_vendedor_real_usd,
    ]).toEqual([80, 0, 80]);
    expect(filaPagoVendedor(conAvion)?.categoria).toBe(
      PAGO_VENDEDOR_AVION_CLAVE_DETALLE,
    );
  });

  it('«(VuelaTour)» en la vigencia: `comisiones_venta_usd` = SOLO la parte bancaria (el pago lo paga VuelaTour en «otros movimientos»)', async () => {
    const a = await avion(conPagoReal(1600, {}, VUELATOUR));
    expect(a.ingresos.comisiones_venta_usd).toBe(15.7);
    expect(a.saldo_disponible_usd).toBe(1778.02);
    const v = a.detalle.vuelos.find((x) => x.id === V1)!;
    expect(v.comision_vendedor_real_usd).toBe(0);
    expect(filaPagoVendedor(a)).toMatchObject({
      categoria: PAGO_VENDEDOR_CLAVE_DETALLE,
      grupo: 'EXCLUIDO',
      etiqueta:
        'Comisión del vendedor (VuelaTour) · egreso en «otros movimientos» del Balance general',
    });
  });

  it('lee la vigencia de `comisiones_al_avion_desde` UNA vez y trae la comisión de cada cobro', async () => {
    const { svc, lecturas, selectsCobro } = armar(mundoReparto());
    await svc.compute({ desde: DESDE, hasta: HASTA });
    expect(lecturas).toEqual([['comisiones_al_avion_desde', '2026-09-01']]);
    expect(selectsCobro).toHaveLength(1);
    for (const col of [
      'comision_banco_monto',
      'comision_banco_pct',
      'metodo_cobro',
    ]) {
      expect(selectsCobro[0]).toContain(col);
    }
  });

  it('CANCELADO con dinero retenido: el avión absorbe la comisión bancaria COMPLETA y NO la «(VuelaTour)» (la paga VuelaTour)', async () => {
    for (const gastos of [[], [gastoComision('g-cv', 1600)]]) {
      const a = await avion(
        mundoReparto({
          vuelo: mundoCon({ v1: { estado: 'CANCELADO' } }).vuelo,
          gasto: mundoCon({ gastos }).gasto,
        }),
      );
      const v = a.detalle.vuelos.find((x) => x.id === V1)!;
      expect(v.comision_banco_avion_usd).toBe(17.5);
      expect(v.comision_vendedor_prov_usd).toBe(0);
      expect(v.comision_vendedor_real_usd).toBe(0);
      expect(a.ingresos.comisiones_venta_usd).toBe(17.5);
      // Lo retenido (2,000 USD) es 100 % del avión.
      expect(a.saldo_disponible_usd).toBe(r2(2000 - 17.5));
    }
  });

  it('CANCELADO con dinero retenido + «(avión)» (13-oct-2026): el avión SÍ la carga (el reparto lee el vuelo); SIN cobros retenidos el reparto se salta el vuelo (`retieneCobros`) y la clave dice que la paga VuelaTour', async () => {
    const cancelado = mundoCon({ v1: { estado: 'CANCELADO' } }).vuelo;
    const a = await avion(
      mundoReparto({
        vuelo: cancelado,
        gasto: mundoCon({
          gastos: [gastoComision('g-cv', 1600, {}, AVION)],
        }).gasto,
      }),
    );
    const v = a.detalle.vuelos.find((x) => x.id === V1)!;
    expect([v.comision_banco_avion_usd, v.comision_vendedor_real_usd]).toEqual([
      17.5, 80,
    ]);
    expect(a.ingresos.comisiones_venta_usd).toBe(97.5);
    expect(a.saldo_disponible_usd).toBe(r2(2000 - 97.5));
    expect(filaPagoVendedor(a)?.categoria).toBe(
      PAGO_VENDEDOR_AVION_CLAVE_DETALLE,
    );
    // Sin cobros: el vuelo no entra al reparto (mismo criterio que antes) y
    // la «(avión)» no la carga nadie.
    const sinCobros = await avion(
      mundoReparto({
        vuelo: cancelado,
        cobro_vuelo: [],
        gasto: mundoCon({
          gastos: [gastoComision('g-cv', 1600, {}, AVION)],
        }).gasto,
      }),
    );
    expect(sinCobros.detalle.vuelos).toHaveLength(0);
    expect(sinCobros.ingresos.comisiones_venta_usd).toBe(0);
    expect(filaPagoVendedor(sinCobros)?.categoria).toBe(
      PAGO_VENDEDOR_AVION_VUELATOUR_CLAVE_DETALLE,
    );
  });

  it('CONFIRMADO con pago real: el reparto no lee el vuelo (solo COMPLETADO y CANCELADO) ⇒ no resta; por fecha_gasto la «(avión)» sale EXCLUIDO «vuelo de otro periodo o aún no completado» y la «(VuelaTour)» con la suya', async () => {
    for (const [categoria, clave] of [
      [AVION, PAGO_VENDEDOR_AVION_OTRO_PERIODO_CLAVE_DETALLE],
      [VUELATOUR, PAGO_VENDEDOR_CLAVE_DETALLE],
    ] as const) {
      const a = await avion(
        mundoReparto({
          vuelo: mundoCon({ v1: { estado: 'CONFIRMADO' } }).vuelo,
          gasto: mundoCon({
            gastos: [gastoComision('g-cv', 1600, {}, categoria)],
          }).gasto,
        }),
      );
      expect(a.ingresos.comisiones_venta_usd).toBe(0);
      expect(a.detalle.vuelos).toHaveLength(0);
      expect(filaPagoVendedor(a)?.categoria).toBe(clave);
    }
  });

  it('MULTI-AVIÓN: cada avión descuenta SU parte (repartirUsd) de la bancaria y del pago REAL; Σ de los dos == comisión × factor + el gasto', async () => {
    const sinPago = mundoMultiAvion();
    const pago1800 = mundoMultiAvion([
      gastoComision(
        'g-cv-3',
        1800,
        {
          vuelo_id: V3,
          vuelo: { folio: 503, aeronave_id: AV },
        },
        AVION,
      ),
    ]);
    const parte = async (mundo: Record<string, Fila[]>, id: string) =>
      (await avion(mundo, undefined, id)).detalle.vuelos.find(
        (x) => x.id === V3,
      )!;
    const tst = await parte(sinPago, AV);
    const dos = await parte(sinPago, AV2);
    // 630.01 ÷ 18 = 35.00 USD × 2,000/2,100 = 33.33 ⇒ 16.67 (principal) +
    // 16.66; sin gasto real el vendedor no resta nada.
    expect([
      tst.comision_banco_avion_usd,
      dos.comision_banco_avion_usd,
    ]).toEqual([16.67, 16.66]);
    expect([
      tst.comision_vendedor_real_usd,
      dos.comision_vendedor_real_usd,
    ]).toEqual([0, 0]);
    // Pago real 1,800 MXN ÷ K 18 = 100 USD ⇒ 50 + 50 (Σ == el gasto).
    const tstP = await parte(pago1800, AV);
    const dosP = await parte(pago1800, AV2);
    expect([
      tstP.comision_vendedor_real_usd,
      dosP.comision_vendedor_real_usd,
    ]).toEqual([50, 50]);
    expect([
      tstP.comision_vendedor_prov_usd,
      dosP.comision_vendedor_prov_usd,
    ]).toEqual([0, 0]);
    expect(
      r2((tstP.comisiones_avion_usd ?? 0) + (dosP.comisiones_avion_usd ?? 0)),
    ).toBe(133.33);
  });

  it('pago MXN sin tc_gasto en un vuelo SIN K (ni T.C. oficial): resta en pesos en el balance pero no llega a USD ⇒ `gastos_sin_tc_*` sube EXACTAMENTE la parte del avión (una vez)', async () => {
    const sinK = (gastos: Fila[]) =>
      mundoReparto({
        vuelo: mundoCon({ v1: { tc_usd_mxn: null, monto_total_mxn: null } })
          .vuelo,
        gasto: mundoCon({ gastos }).gasto,
      });
    const sin = await avion(sinK([]));
    const con = await avion(sinK([gastoComision('g-cv', 1600, {}, AVION)]));
    expect(
      con.detalle.vuelos.find((x) => x.id === V1)!.comision_vendedor_real_usd,
    ).toBe(0);
    expect(
      con.gastos.gastos_sin_tc_count - sin.gastos.gastos_sin_tc_count,
    ).toBe(1);
    expect(
      r2(con.gastos.gastos_sin_tc_mxn - sin.gastos.gastos_sin_tc_mxn),
    ).toBe(1600);
    expect(con.saldo_disponible_usd).toBe(sin.saldo_disponible_usd);
  });

  it('utilidades por mes (cuenta corriente): los socios reciben su parte del saldo DESPUÉS de comisiones; el pago capturado en octubre de un vuelo de septiembre resta en SEPTIEMBRE', async () => {
    // LA CUENTA ES EN PESOS (20-oct-2026, invariante 99): la cuenta LEE
    // `reparto[].monto_mxn` del reparto del mes. En dólares (informativo)
    // los socios recibían 1,262.39 / 515.63 y, con el pago, 1,205.59 /
    // 492.43: en pesos, lo MISMO que el reparto de septiembre dice.
    const { svc } = armar(mundoReparto());
    const [sep] = await svc.utilidadesSociosPorMes(['2026-09'], '2026-10');
    const repSep = (
      await svc.compute({ desde: '2026-09-01', hasta: '2026-09-30' })
    ).aviones.find((x) => x.aeronave.id === AV)!;
    expect(repSep.reparto.map((s) => [s.socio_id, s.monto_usd])).toEqual([
      [MAU, 1262.39],
      [ACC, 515.63],
    ]);
    expect(
      sep.aviones
        .find((x) => x.aeronave.id === AV)!
        .socios.map((s) => [s.socio_id, s.monto_mxn]),
    ).toEqual(repSep.reparto.map((s) => [s.socio_id, s.monto_mxn]));
    const conPago = armar(conPagoReal(1600, { fecha_gasto: '2026-10-05' }));
    const [sep2, oct2] = await conPago.svc.utilidadesSociosPorMes(
      ['2026-09', '2026-10'],
      '2026-11',
    );
    const repSep2 = (
      await conPago.svc.compute({ desde: '2026-09-01', hasta: '2026-09-30' })
    ).aviones.find((x) => x.aeronave.id === AV)!;
    expect(repSep2.reparto.map((s) => [s.socio_id, s.monto_usd])).toEqual([
      [MAU, 1205.59],
      [ACC, 492.43],
    ]);
    expect(
      sep2.aviones
        .find((x) => x.aeronave.id === AV)!
        .socios.map((s) => [s.socio_id, s.monto_mxn]),
    ).toEqual(repSep2.reparto.map((s) => [s.socio_id, s.monto_mxn]));
    // El pago resta en pesos en septiembre (menos para los dos socios).
    for (const [i, s] of repSep2.reparto.entries()) {
      expect(s.monto_mxn).toBeLessThan(repSep.reparto[i].monto_mxn);
    }
    // Octubre: nada del pago (su vuelo es de septiembre).
    const octTst = oct2.aviones.find((x) => x.aeronave.id === AV);
    expect(
      r2((octTst?.socios ?? []).reduce((s, x) => s + x.monto_mxn, 0)),
    ).toBe(0);
  });

  it('el payload del PDF/XLSX lleva la bandera `comision_vendedor_solo_gasto_real: true` al nivel raíz', async () => {
    const { svc } = armar(mundoReparto());
    const { payload } = await (
      svc as unknown as {
        buildRepartoPayload: (q: {
          desde: string;
          hasta: string;
        }) => Promise<{ payload: Record<string, unknown> }>;
      }
    ).buildRepartoPayload({ desde: DESDE, hasta: HASTA });
    expect(payload.comision_vendedor_solo_gasto_real).toBe(true);
    expect(Object.keys(payload).slice(-1)).toEqual([
      'comision_vendedor_solo_gasto_real',
    ]);
  });
});

describe('Reparto ↔ balance por avión: las MISMAS comisiones (fuente única)', () => {
  it('la cifra del vendedor del reparto × K == `comision_vendedor_real_mxn` del libro, la bancaria cuadra al centavo con su conversión y Δ utilidad cobrada == Δ saldo', async () => {
    const mundo = conPagoReal(1600);
    const a = await avion(mundo);
    const v = a.detalle.vuelos.find((x) => x.id === V1)!;
    const libro = await libroBalance(mundo);
    const fila = libro.vuelos.find((x) => x.vuelo_id === V1)!;
    const k = fila.tc_venta!;
    expect(r2((v.comision_vendedor_real_usd ?? 0) * k)).toBe(
      fila.comision_vendedor_real_mxn,
    );
    expect(fila.comision_vendedor_real_mxn).toBe(1600);
    expect(fila.comision_vendedor_real_pagos).toBe(1);
    expect(fila.comision_vendedor_prov_mxn).toBe(0);
    expect(
      Math.abs(
        (v.comision_banco_avion_usd ?? 0) -
          (fila.comision_banco_avion_mxn ?? 0) / k,
      ),
    ).toBeLessThan(0.01);
    // El pago real mueve la utilidad cobrada del balance y el saldo del
    // reparto EXACTAMENTE lo mismo (−1,600 ÷ 20 = −80 USD).
    const sinPago = await avion(mundoReparto());
    const libroSin = await libroBalance(mundoReparto());
    const dSaldo = r2(a.saldo_disponible_usd - sinPago.saldo_disponible_usd);
    const dCobrada = r2(
      (libro.balance.utilidad_cobrada_usd ?? 0) -
        (libroSin.balance.utilidad_cobrada_usd ?? 0),
    );
    expect(dSaldo).toBe(-80);
    expect(dCobrada).toBe(dSaldo);
  });

  // Revisión 13-oct-2026 (invariante 61): el reparto pedía el T.C. oficial
  // SOLO para los vuelos cuyos COBROS lo necesitaban; el balance lo resuelve
  // para TODO vuelo sin tc_usd_mxn. Un pago «(avión)» en pesos sin tc_gasto
  // en un vuelo sin tc_usd_mxn con cobros que traen su T.C. (el caso normal
  // en prod: 101 de 271 vuelos COMPLETADO de jul–oct sin tc_usd_mxn) restaba
  // en el balance y NO en el reparto (quedaba en `gastos_sin_tc`): los
  // socios cobraban el pago completo de más.
  it('vuelo SIN tc_usd_mxn, con T.C. oficial y cobros que NO lo piden: el pago «(avión)» MXN sin tc_gasto usa el MISMO K que el balance — USD == MXN ÷ K, comisiones_venta_usd == balance.comisiones_usd y Δ saldo == Δ utilidad cobrada; los conteos del T.C. oficial de los cobros no cambian', async () => {
    const OFICIAL = 17;
    const mundoSinTc = (gastos: Fila[]) =>
      mundoReparto({
        vuelo: mundoCon({ v1: { tc_usd_mxn: null } }).vuelo,
        gasto: mundoCon({ gastos }).gasto,
      });
    const conPago = mundoSinTc([gastoComision('g-cv', 1600, {}, AVION)]);
    const sinPago = mundoSinTc([]);
    const reparto = async (mundo: Record<string, Fila[]>) => {
      const { svc } = armar(mundo, undefined, OFICIAL);
      const r = await svc.compute({ desde: DESDE, hasta: HASTA });
      const a = r.aviones.find((x) => x.aeronave.id === AV);
      if (!a) throw new Error('sin avión');
      return { r, a };
    };
    const con = await reparto(conPago);
    const sin = await reparto(sinPago);
    const libroCon = await libroBalance(conPago, undefined, OFICIAL);
    const libroSin = await libroBalance(sinPago, undefined, OFICIAL);
    const fila = libroCon.vuelos.find((x) => x.vuelo_id === V1)!;
    const v = con.a.detalle.vuelos.find((x) => x.id === V1)!;
    // El balance: K = oficial del día de la cotización; el pago resta en
    // pesos en su columna COMISIONES.
    expect(fila.tc_venta).toBe(OFICIAL);
    expect(fila.comision_vendedor_real_mxn).toBe(1600);
    expect(fila.comision_vendedor_real_pagos).toBe(1);
    // El reparto: el MISMO K ⇒ 1,600 ÷ 17 = 94.12 USD.
    expect(v.comision_vendedor_real_usd).toBe(r2(1600 / OFICIAL));
    expect(v.comision_vendedor_real_usd).toBe(
      r2((fila.comision_vendedor_real_mxn ?? 0) / fila.tc_venta!),
    );
    expect(con.a.ingresos.comisiones_venta_usd).toBe(
      libroCon.balance.comisiones_usd,
    );
    expect(sin.a.ingresos.comisiones_venta_usd).toBe(
      libroSin.balance.comisiones_usd,
    );
    // El pago mueve el saldo del reparto y la utilidad cobrada del balance
    // EXACTAMENTE lo mismo, y ya no cae en `gastos_sin_tc`.
    const dSaldo = r2(con.a.saldo_disponible_usd - sin.a.saldo_disponible_usd);
    const dCobrada = r2(
      (libroCon.balance.utilidad_cobrada_usd ?? 0) -
        (libroSin.balance.utilidad_cobrada_usd ?? 0),
    );
    expect(dSaldo).toBe(-r2(1600 / OFICIAL));
    expect(dCobrada).toBe(dSaldo);
    expect(con.a.gastos.gastos_sin_tc_count).toBe(
      sin.a.gastos.gastos_sin_tc_count,
    );
    expect(con.a.gastos.gastos_sin_tc_mxn).toBe(sin.a.gastos.gastos_sin_tc_mxn);
    // Los conteos y el detalle del T.C. oficial siguen siendo de los COBROS:
    // los de este vuelo traen su T.C., así que no lo usaron.
    expect(v.tc_oficial).toBeUndefined();
    expect(con.a.ingresos.cobros_tc_oficial_count).toBe(0);
    expect(con.r.tc_oficial.vuelos).toBe(sin.r.tc_oficial.vuelos);
  });
});

describe('Reparto — COMISIONES: revisión 6-oct-2026', () => {
  it('la vigencia (de la parte BANCARIA) se corta por DÍA CANCÚN del vuelo: 31-ago 23:00 Cancún (1-sep 04:00 UTC) no aplica; 1-sep 00:00 Cancún sí — la «(avión)» resta en los dos', async () => {
    const enFecha = async (fecha: string, gastos: Fila[]) => {
      const m = mundoReparto({
        vuelo: mundoCon({ v1: { fecha_vuelo: fecha } }).vuelo,
        gasto: mundoCon({ gastos }).gasto,
      });
      const { svc } = armar(m);
      const r = await svc.compute({ desde: '2026-08-01', hasta: HASTA });
      return r.aviones.find((x) => x.aeronave.id === AV)!;
    };
    const agosto = await enFecha('2026-09-01T04:00:00+00:00', []);
    expect(agosto.ingresos.comisiones_venta_usd).toBe(0);
    expect(agosto.saldo_disponible_usd).toBe(1793.72);
    expect(
      'comisiones_avion_usd' in agosto.detalle.vuelos.find((x) => x.id === V1)!,
    ).toBe(false);
    const septiembre = await enFecha('2026-09-01T05:00:00+00:00', []);
    expect(septiembre.ingresos.comisiones_venta_usd).toBe(15.7);
    // Con una «(avión)» de 1,600 (÷ 20 = 80): agosto solo el pago (sin la
    // bancaria) y con las llaves del detalle; septiembre banco + pago.
    const pago = [gastoComision('g-cv', 1600, {}, AVION)];
    const agostoPago = await enFecha('2026-09-01T04:00:00+00:00', pago);
    expect(agostoPago.ingresos.comisiones_venta_usd).toBe(80);
    const vAgo = agostoPago.detalle.vuelos.find((x) => x.id === V1)!;
    expect([
      vAgo.comision_banco_avion_usd,
      vAgo.comision_vendedor_real_usd,
    ]).toEqual([0, 80]);
    expect(
      (await enFecha('2026-09-01T05:00:00+00:00', pago)).ingresos
        .comisiones_venta_usd,
    ).toBe(95.7);
  });

  it('vuelo SIN T.C. capturado con un cobro MXN sin T.C. propio: la comisión bancaria y el pago real se convierten con el T.C. oficial del día de la cotización (la cadena de `cobrosEnUsd`)', async () => {
    const m = mundoReparto({
      vuelo: mundoCon({
        v1: {
          tc_usd_mxn: null,
          monto_total_mxn: null,
          fecha_solicitud: '2026-09-01T15:00:00+00:00',
        },
      }).vuelo,
      gasto: mundoCon({ gastos: [gastoComision('g-cv', 1500, {}, AVION)] })
        .gasto,
    });
    m.cobro_vuelo = m.cobro_vuelo.map((c) =>
      c.id === 'c-1' ? { ...c, tc_usd_mxn: null } : c,
    );
    const a = await avion(m, undefined, AV);
    // Sin T.C. oficial no habría conversión: el mundo de arriba lo pide.
    const { svc } = armar(m, undefined, 18.75);
    const r = await svc.compute({ desde: DESDE, hasta: HASTA });
    const conOficial = r.aviones.find((x) => x.aeronave.id === AV)!;
    const v = conOficial.detalle.vuelos.find((x) => x.id === V1)!;
    expect(v.tc_oficial?.tc).toBe(18.75);
    // round2(350 ÷ 18.75) = 18.67 × 2,000/2,230 = 16.74; pago real 1,500 ÷
    // 18.75 = 80.
    expect(v.comision_banco_avion_usd).toBe(16.74);
    expect(v.comision_vendedor_real_usd).toBe(80);
    expect(conOficial.ingresos.comisiones_venta_usd).toBe(96.74);
    // Sin T.C. oficial (red caída) ni la comisión del cobro MXN ni el pago
    // MXN se inventan en USD (el pago va a `gastos_sin_tc_*`).
    const vSin = a.detalle.vuelos.find((x) => x.id === V1)!;
    expect(vSin.comision_banco_avion_usd).toBe(0);
    expect(vSin.comision_vendedor_real_usd).toBe(0);
  });
});

describe('Reparto ↔ balance por avión — revisión 6-oct-2026', () => {
  it('vuelos AÚN NO realizados (COTIZADO, RESERVA, CONFIRMADO) con comisión del vendedor y hasta con una «(avión)»: ni el balance ni el reparto se los cargan al avión ⇒ Δ utilidad cobrada del balance == Δ saldo del reparto', async () => {
    const base = mundoConNoRealizados();
    const mundo = {
      ...base,
      gasto: [
        ...base.gasto,
        gastoComision('g-cv', 1600, {}, AVION),
        // «(avión)» del #512 CONFIRMADO: fuera del universo, la paga
        // VuelaTour (no el avión) hasta que se complete.
        gastoComision(
          'g-cv-512',
          500,
          {
            vuelo_id: 'v-12',
            vuelo: { folio: 512, aeronave_id: AV },
          },
          AVION,
        ),
      ],
    };
    const balanceCon = await libroBalance(mundo);
    const balanceAntes = await libroBalance(mundo, POSTERIOR);
    const repartoCon = await avion(mundo);
    const repartoAntes = await avion(mundo, POSTERIOR);
    const dSaldo = r2(
      repartoCon.saldo_disponible_usd - repartoAntes.saldo_disponible_usd,
    );
    const dCobrada = r2(
      (balanceCon.balance.utilidad_cobrada_usd ?? 0) -
        (balanceAntes.balance.utilidad_cobrada_usd ?? 0),
    );
    // La «(avión)» del #501 resta en las DOS reglas (no depende de la
    // vigencia): la diferencia es SOLO la bancaria (15.70); el #512 nunca.
    expect(dSaldo).toBe(-15.7);
    expect(repartoCon.ingresos.comisiones_venta_usd).toBe(95.7);
    expect(repartoAntes.ingresos.comisiones_venta_usd).toBe(80);
    // Solo el redondeo de la ganancia USD de la fila (centavos).
    expect(Math.abs(dCobrada - dSaldo)).toBeLessThan(0.02);
    expect(balanceCon.totales.comision_vendedor_real_mxn).toBe(1600);
    expect(balanceCon.totales.comision_vendedor_prov_mxn).toBe(0);
    const f512 = balanceCon.vuelos.find((x) => x.vuelo_id === 'v-12')!;
    expect([
      f512.comision_vendedor_real_mxn,
      f512.comision_vendedor_real_pagos,
    ]).toEqual([0, 0]);
  });

  it('vuelo SIN T.C. capturado: la cifra del vendedor del reparto × K oficial == `comision_vendedor_real_mxn` del balance y la bancaria cuadra con su conversión', async () => {
    const mundo = mundoReparto({
      vuelo: mundoCon({
        v1: {
          tc_usd_mxn: null,
          monto_total_mxn: null,
          fecha_solicitud: '2026-09-01T15:00:00+00:00',
        },
      }).vuelo,
      gasto: mundoCon({ gastos: [gastoComision('g-cv', 1500, {}, AVION)] })
        .gasto,
    });
    mundo.cobro_vuelo = mundo.cobro_vuelo.map((c) =>
      c.id === 'c-1' ? { ...c, tc_usd_mxn: null } : c,
    );
    const { svc } = armar(mundo, undefined, 18.75);
    const r = await svc.compute({ desde: DESDE, hasta: HASTA });
    const v = r.aviones
      .find((x) => x.aeronave.id === AV)!
      .detalle.vuelos.find((x) => x.id === V1)!;
    const fila = (await libroBalance(mundo, undefined, 18.75)).vuelos.find(
      (x) => x.vuelo_id === V1,
    )!;
    const k = fila.tc_venta!;
    expect(k).toBe(18.75);
    expect(r2((v.comision_vendedor_real_usd ?? 0) * k)).toBe(
      fila.comision_vendedor_real_mxn,
    );
    expect(fila.comision_vendedor_real_mxn).toBe(1500);
    expect(fila.comision_vendedor_prov_mxn).toBe(0);
    expect(
      Math.abs(
        (v.comision_banco_avion_usd ?? 0) -
          (fila.comision_banco_avion_mxn ?? 0) / k,
      ),
    ).toBeLessThan(0.01);
  });
});

/**
 * EL PAGO AL OPERADOR EXTERNO ES EL GASTO REAL (16-oct-2026, invariante 88).
 * El bloque `externos` del reparto nunca contó los gastos del externo (solo
 * `costo_externo_usd`): aquí no había doble conteo. Con la MISMA decisión
 * del balance y del reporte (`pagoOperadorExternoEnGastos`), si un gasto
 * del vuelo ES el pago al operador, `costo_usd` usa LO PAGADO (ese gasto ÷
 * tc_gasto ?? K) — así los tres lectores dan el mismo número.
 */
describe('Reparto — bloque externos: el gasto real cubre el costo del operador (invariante 88)', () => {
  const VEXT = 'v-ext';
  const externo = (extra: Fila = {}): Fila => ({
    ...vuelo2(),
    id: VEXT,
    folio: 308,
    aeronave_id: null,
    es_externo: true,
    operador_externo: 'CarlosMuciño',
    costo_externo_usd: '1490.26',
    tc_usd_mxn: 17,
    comision_vendedor_usd: 0,
    ...extra,
  });
  const pago = (monto: number, extra: Fila = {}): Fila => ({
    id: `g-ext-${monto}`,
    vuelo_id: VEXT,
    aeronave_id: null,
    escala_id: null,
    categoria: 'OPERACIONES',
    monto,
    moneda: 'MXN',
    tc_gasto: null,
    fecha_gasto: '2026-09-15',
    vuelo: { es_externo: true, aeronave_id: null },
    ...extra,
  });
  async function externosDe(
    v: Fila,
    gastos: Fila[],
    tcOficial: number | null = null,
  ) {
    const m = mundoReparto();
    const { svc } = armar(
      { ...m, vuelo: [...m.vuelo, v], gasto: [...m.gasto, ...gastos] },
      undefined,
      tcOficial,
    );
    return (await svc.compute({ desde: DESDE, hasta: HASTA })).externos;
  }

  it('sin gasto que coincida ⇒ el costo capturado (igual que hoy)', async () => {
    expect((await externosDe(externo(), [])).costo_usd).toBe(1490.26);
    expect((await externosDe(externo(), [pago(1118.12)])).costo_usd).toBe(
      1490.26,
    );
  });

  it('un gasto ES el pago ⇒ costo_usd = lo pagado (25,500 ÷ 17 = 1,500), no el capturado', async () => {
    expect((await externosDe(externo(), [pago(25500)])).costo_usd).toBe(1500);
    // #308 real: 25,334.40 ÷ 17 = 1,490.26 — el mismo número que el balance.
    expect((await externosDe(externo(), [pago(25334.4)])).costo_usd).toBe(
      1490.26,
    );
  });

  it('sin T.C. en la cotización: el K oficial del día de la cotización decide (el mismo del balance)', async () => {
    const sinTc = externo({ tc_usd_mxn: null });
    expect((await externosDe(sinTc, [pago(25500)], 17)).costo_usd).toBe(1500);
    // Sin ningún T.C. el gasto en pesos no se puede comparar: el capturado.
    expect((await externosDe(sinTc, [pago(25500)], null)).costo_usd).toBe(
      1490.26,
    );
  });

  it('CANCELADO ⇒ igual que hoy (el costo no resta)', async () => {
    expect(
      (await externosDe(externo({ estado: 'CANCELADO' }), [pago(25500)]))
        .costo_usd,
    ).toBe(0);
  });
});
