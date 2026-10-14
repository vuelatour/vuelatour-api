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
  BalanceAvionVueloPayload,
  BalanceEmpresaBloquePayload,
  BalanceGeneralResumenFilaPayload,
  BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  AVION,
  DESDE,
  GOLDEN_OM,
  HASTA,
  V1,
  V2,
  VUELATOUR,
  fakeSupabase,
  gastoComision,
  mundoCon,
  mundoLibros,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65). Pedido del cliente:
 * «cuando hay una comisión de un banco, en la parte de total cobrado no
 * refleja el monto real que entró a la cuenta… la comisión del banco y
 * vendedor se puede ir a la columna (comisiones del vendedor) pero cambiar
 * el nombre a "comisiones"… Por si no le estaríamos poniendo dinero al
 * socio.» Respuestas: la comisión del vendedor la absorbe el avión; lo
 * cobrado al cliente por ella se queda como ingreso de VuelaTour; vigencia
 * desde septiembre de 2026.
 *
 * 13-oct-2026 (API 0.0.74, invariante 61; decisión 3 del lote del cliente
 * ajustada el mismo día: DOS categorías): la parte del VENDEDOR es el pago
 * REAL capturado como «Comisión del vendedor (avión)» — Σ de esos gastos
 * ligados al vuelo (TODOS los del vuelo, sin importar el avión sellado),
 * con el vuelo COMPLETADO o CANCELADO con cobros retenidos, en cualquier
 * fecha; la «Comisión del vendedor (VuelaTour)» NUNCA la carga el avión
 * (la paga VuelaTour en «otros movimientos»). Sin pago capturado no se resta
 * nada (la provisión murió) y el balance avisa el pendiente de captura. Los
 * casos de absorción de la D3 se re-apuntaron a la «(avión)» (`conPago`)
 * con las mismas cifras.
 *
 * Mundo de los libros: vuelo #501 (XB-TST, 10-sep, K 20) de 2,230 USD =
 * 2,000 de tiempo + 100 TUAS + 50 extras + 80 de comisión del vendedor (sin
 * IVA) ⇒ factor del avión 2,000/2,230; cobros: 20,000 MXN con comisión
 * bancaria de 350 y 1,000 USD sin comisión.
 *  - BANCO: 350 × 0.896861 = 313.90 al avión (36.10 de VuelaTour).
 *  - VENDEDOR: sin gasto, 0 (hasta el 0.0.73: provisión 80 USD × 20 =
 *    1,600) ⇒ COMISIONES 313.90 y ganancia 40,000 − 313.90 = 39,686.10;
 *    con un gasto real de 1,600 MXN ⇒ COMISIONES 1,913.90 y ganancia
 *    38,086.10.
 */

const AV2 = 'av-2';
const V3 = 'v-3';
const V4 = 'v-4';
const r2 = (x: number) => Math.round(x * 100) / 100;

const DEFAULT = '2026-09-01';
/** Vigencia POSTERIOR a todo el mundo de septiembre: la regla de siempre. */
const POSTERIOR = '2026-12-01';

const socio = (
  aeronaveId: string,
  socioId: string,
  porcentaje: string,
  nombre: string,
  esEmpresa: boolean,
): Fila => ({
  aeronave_id: aeronaveId,
  socio_id: socioId,
  porcentaje,
  vigente_desde: '2020-01-01',
  vigente_hasta: null,
  usuario: { nombre, es_empresa: esEmpresa },
});

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  resumen: BalanceGeneralResumenFilaPayload[];
  resumen_totales: BalanceGeneralResumenFilaPayload;
  empresa?: BalanceEmpresaBloquePayload;
};

/** Sin ConfiguracionService (como arman el servicio los specs viejos). */
const SIN_CONFIG = Symbol('sin-config');

/**
 * Servicio con el mundo en memoria. `vigencia`: lo que contesta la
 * configuración (`undefined` ⇒ su default; `SIN_CONFIG` ⇒ el servicio se
 * arma SIN ConfiguracionService). `tcOficial`: lo que contesta el T.C.
 * oficial de cualquier día (null ⇒ sin dato, como siempre).
 */
function armar(
  mundo: Record<string, Fila[]>,
  vigencia?: string | typeof SIN_CONFIG,
  tcOficial: number | null = null,
) {
  const f = fakeSupabase(mundo);
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const lecturas: Array<[string, string]> = [];
  const valor = vigencia === SIN_CONFIG ? undefined : vigencia;
  const config =
    vigencia === SIN_CONFIG
      ? undefined
      : {
          fecha: (clave: string, porDefecto: string) => {
            lecturas.push([clave, porDefecto]);
            return Promise.resolve(valor ?? porDefecto);
          },
        };
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
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
    {
      oficialDetallePara: (dia: string) =>
        Promise.resolve(
          tcOficial == null
            ? null
            : { tc: tcOficial, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        ),
    } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
    config as never,
  );
  return { service, enviados, lecturas };
}

async function libro(
  mundo: Record<string, Fila[]>,
  vigencia?: string | typeof SIN_CONFIG,
  avion: string = AV,
): Promise<BalanceAvionPayload> {
  const a = armar(mundo, vigencia);
  await a.service.xlsx(avion, DESDE, HASTA);
  return a.enviados.individual!;
}

async function general(
  mundo: Record<string, Fila[]>,
  vigencia?: string,
  tcOficial: number | null = null,
): Promise<General> {
  const a = armar(mundo, vigencia, tcOficial);
  await a.service.xlsxGeneral(DESDE, HASTA);
  return a.enviados.general!;
}

const filaDe = (
  vuelos: BalanceAvionVueloPayload[],
  vueloId: string,
): BalanceAvionVueloPayload => {
  const f = vuelos.find((x) => x.vuelo_id === vueloId);
  if (!f) throw new Error(`sin fila del vuelo ${vueloId}`);
  return f;
};

const omDe = (g: General, folio: number): BalanceOtroMovimientoFilaPayload => {
  const f = g.consolidado.otros_movimientos!.filas.find((x) =>
    x.clave.endsWith(String(folio)),
  );
  if (!f) throw new Error(`sin fila de otros movimientos del #${folio}`);
  return f;
};

/** Rutas (a.b.0.c) donde dos payloads difieren. */
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

const sinSello = (p: BalanceAvionPayload) => ({ ...p, generado: null });

/** Texto del pendiente de captura del #501 (invariante 61, dos categorías). */
const PENDIENTE_CAPTURA_501 =
  "comisión del vendedor cotizada ($80.00 USD) sin pago capturado — captúralo en Gastos ligado a este vuelo como «Comisión del vendedor (avión)» si lo carga el avión (resta en su columna COMISIONES) o como «Comisión del vendedor (VuelaTour)» si lo paga VuelaTour ('otros movimientos' del Balance general)";

/**
 * El #501 con un pago real al vendedor: «Comisión del vendedor (avión)» por
 * default (los casos de absorción de la D3), `categoria: VUELATOUR` para la
 * que paga VuelaTour.
 */
const conPago = (
  monto: number,
  extra: Fila = {},
  opts: { v1?: Fila; categoria?: typeof VUELATOUR | typeof AVION } = {},
) =>
  mundoCon({
    v1: opts.v1,
    gastos: [gastoComision('g-cv', monto, extra, opts.categoria ?? AVION)],
  });

/** El cobro de 20,000 con «cómo se cobró» completo y su % de comisión. */
function mundoComoSeCobro(): Record<string, Fila[]> {
  const m = mundoLibros();
  return {
    ...m,
    cobro_vuelo: m.cobro_vuelo.map((c) =>
      c.id === 'c-1'
        ? {
            ...c,
            comision_banco_pct: 1.75,
            metodo_cobro: 'TRANSFERENCIA',
            cuenta_destino: 'Scotiabank Pesos',
            registrado_por: 'u-itzi',
            registro: { nombre: 'Itzi' },
          }
        : c,
    ),
  };
}

/** Tramo con la forma que leen el libro y la cadena de tacos. */
function tramo(
  id: string,
  vueloId: string,
  orden: number,
  extra: Fila & { fecha: string; avionVuelo: string | null },
): Fila {
  const { fecha, avionVuelo, ...resto } = extra;
  return {
    id,
    vuelo_id: vueloId,
    orden,
    aeronave_id: null,
    cancelada_at: null,
    taco_salida: null,
    taco_llegada: null,
    solo_operativa: false,
    es_ferry: false,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    es_sobrevuelo: false,
    tipo_parada: 'NORMAL',
    pasajeros: 2,
    fecha_salida_plan: fecha,
    taco_salida_obs: null,
    taco_llegada_obs: null,
    taco_obs_updated_by: null,
    taco_obs_updated_at: null,
    vuelo: { fecha_vuelo: fecha, aeronave_id: avionVuelo },
    ...resto,
  };
}

/**
 * + #503 MULTI-AVIÓN (XB-TST principal + un tramo de XB-DOS, 50/50): 2,100
 * USD = 2,000 de tiempo + 100 de comisión del vendedor (Pablo Canales), K
 * 18, cobrado completo (37,800 MXN) con 630.01 de comisión bancaria.
 * + #504 EXTERNO sin avión (operador XA-TYV): 1,000 USD, K 18, cobrado con
 * 900 de comisión bancaria.
 */
function mundoFlota(): Record<string, Fila[]> {
  const m = mundoLibros();
  const f3 = '2026-09-15T15:00:00+00:00';
  const f4 = '2026-09-18T15:00:00+00:00';
  return {
    ...m,
    aeronave: [
      ...m.aeronave,
      {
        id: AV2,
        matricula: 'XB-DOS',
        modelo: 'C206',
        color_calendario: '#10B981',
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
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
        comision_vendedor_nombre: 'Pablo Canales',
        monto_total_usd: 2100,
        monto_total_mxn: 37800,
      }),
      vuelo2({
        id: V4,
        folio: 504,
        aeronave_id: null,
        es_externo: true,
        operador_externo: 'XA-TYV',
        costo_externo_usd: 500,
        fecha_vuelo: f4,
      }),
    ],
    escala: [
      ...m.escala,
      tramo('e-3a', V3, 1, { fecha: f3, avionVuelo: AV }),
      tramo('e-3b', V3, 2, {
        fecha: '2026-09-15T18:00:00+00:00',
        avionVuelo: AV,
        aeronave_id: AV2,
        origen_iata: 'MID',
        destino_iata: 'CUN',
      }),
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
      {
        id: 'c-5',
        vuelo_id: V4,
        monto: 18000,
        moneda: 'MXN',
        tc_usd_mxn: 18,
        fecha_cobro: '2026-09-18T20:00:00+00:00',
        comision_banco_monto: 900,
      },
    ],
  };
}

describe('Balance por avión — COMISIONES a cargo del avión (API 0.0.65)', () => {
  it('fila del #501 SIN gasto real: COMISIONES = SOLO la parte del avión de la comisión bancaria (la provisión murió), la ganancia queda después de ella y el balance avisa el pendiente de captura', async () => {
    const p = await libro(mundoLibros());
    const f = filaDe(p.vuelos, V1);
    expect(f.remanente_mxn).toBe(40000);
    expect(f.comision_banco_avion_mxn).toBe(313.9);
    expect(f.comision_vendedor_prov_mxn).toBe(0);
    expect(f.comision_vendedor_real_mxn).toBe(0);
    expect(f.comision_vendedor_real_pagos).toBe(0);
    expect(f.comisiones_mxn).toBe(313.9);
    expect(f.comisiones_detalle).toEqual([
      'Comisión bancaria · $350.00 (parte del avión 89.69 %: $313.90)',
    ]);
    // Hasta el 0.0.73: 38,086.10 (− 1,600 de provisión).
    expect(f.ganancia_mxn).toBe(39686.1);
    expect(f.ganancia_usd).toBe(r2(39686.1 / 20));
    expect(
      p.pendientes.filter((x) => x.includes(PENDIENTE_CAPTURA_501)),
    ).toHaveLength(1);
    // La columna vieja sigue null (compatibilidad de shape).
    expect(f.comision_vendedor_mxn).toBeNull();
    // Lo COBRADO AL AVIÓN no cambia de cálculo (bruto × factor) y un vuelo
    // pagado sigue dando su por cobrar de siempre.
    expect(f.cobrado_mxn).toBe(r2(r2(2000 * (2000 / 2230)) * 20));
    expect(f.por_cobrar_mxn).toBe(r2(40000 - f.cobrado_mxn));
  });

  it('fila del #501 CON gasto real de $1,600 MXN — sellado a OTRO avión (el avión del gasto es solo referencia): COMISIONES = banco + EXACTAMENTE lo pagado, nota «gasto real», sin pendiente de captura; los totales llevan `comision_vendedor_real_mxn`', async () => {
    const p = await libro(conPago(1600, { aeronave_id: 'av-otro' }));
    const f = filaDe(p.vuelos, V1);
    expect([
      f.comision_banco_avion_mxn,
      f.comision_vendedor_prov_mxn,
      f.comision_vendedor_real_mxn,
      f.comision_vendedor_real_pagos,
      f.comisiones_mxn,
    ]).toEqual([313.9, 0, 1600, 1, 1913.9]);
    expect(f.comisiones_detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · $350.00 (parte del avión 89.69 %: $313.90)',
      'Comisión vendedor (Vendedor Uno) · $1,600.00 · gasto real',
    ]);
    expect(f.ganancia_mxn).toBe(38086.1);
    expect(f.ganancia_usd).toBe(r2(38086.1 / 20));
    expect(p.totales.comision_vendedor_real_mxn).toBe(1600);
    expect(p.totales.comisiones_mxn).toBe(1913.9);
    expect(p.pendientes.join(' | ')).not.toContain('sin pago capturado');
    // El pago restó en COMISIONES, no en las columnas de costo del avión.
    const sin = filaDe((await libro(mundoLibros())).vuelos, V1);
    for (const k of [
      'op_mxn',
      'piloto_mxn',
      'otros_mxn',
      'costo_total_mxn',
      'tc_costos',
    ] as const) {
      expect([k, f[k]]).toEqual([k, sin[k]]);
    }
    // Dos pagos ⇒ «(2 pagos)» y la suma cruda.
    const dos = filaDe(
      (
        await libro(
          mundoCon({
            gastos: [
              gastoComision(
                'g-cv-1',
                1000,
                { fecha_gasto: '2026-09-12' },
                AVION,
              ),
              gastoComision(
                'g-cv-2',
                600,
                { fecha_gasto: '2026-10-02' },
                AVION,
              ),
            ],
          }),
        )
      ).vuelos,
      V1,
    );
    expect(dos.comision_vendedor_real_mxn).toBe(1600);
    expect(dos.comision_vendedor_real_pagos).toBe(2);
    expect(dos.comisiones_detalle).toContain(
      'Comisión vendedor (Vendedor Uno) · $1,600.00 · gasto real (2 pagos)',
    );
  });

  it('cada COBRO n dice lo que ENTRÓ: `neto_mxn`, la nota con bruto · comisión · neto y COBRADO REAL = Σ netos', async () => {
    const p = await libro(mundoComoSeCobro());
    const f = filaDe(p.vuelos, V1);
    expect(
      f.cobros.map((c) => [
        c.monto_mxn,
        c.comision_mxn,
        c.neto_mxn,
        c.cobrado_con,
      ]),
    ).toEqual([
      [
        20000,
        350,
        19650,
        'Bruto $20,000.00 · comisión banco 1.75 % $350.00 · neto $19,650.00 · Transferencia → Scotiabank Pesos · Registró: Itzi',
      ],
      // Sin comisión: neto = bruto y la nota de siempre (aquí, ninguna).
      [20000, null, 20000, null],
    ]);
    expect(f.cobrado_real_mxn).toBe(39650);
    expect(p.totales.cobrado_real_mxn).toBe(39650);
    // `neto_mxn` va AL FINAL de cada cobro (aditivo).
    expect(Object.keys(f.cobros[0])).toEqual([
      'fecha',
      'monto_mxn',
      'metodo',
      'comision_mxn',
      'cuenta',
      'metodo_etiqueta',
      'registro',
      'cobrado_con',
      'neto_mxn',
    ]);
  });

  it('sin método, cuenta ni registro, la nota del cobro con comisión es solo bruto · comisión · neto', async () => {
    const p = await libro(mundoLibros());
    expect(filaDe(p.vuelos, V1).cobros[0].cobrado_con).toBe(
      'Bruto $20,000.00 · comisión banco $350.00 · neto $19,650.00',
    );
  });

  it('los campos nuevos de la fila van AL FINAL y los TOTALES suman COMISIONES; la cascada del balance sale de la ganancia después de comisiones', async () => {
    const p = await libro(mundoLibros());
    const f = filaDe(p.vuelos, V1);
    expect(Object.keys(f).slice(-7)).toEqual([
      'factura_vuelatour',
      'comisiones_mxn',
      'comisiones_detalle',
      'comision_banco_avion_mxn',
      'comision_vendedor_prov_mxn',
      'comision_vendedor_real_mxn',
      'comision_vendedor_real_pagos',
    ]);
    expect(p.totales.comisiones_mxn).toBe(313.9);
    expect(p.totales.comision_banco_avion_mxn).toBe(313.9);
    expect(p.totales.comision_vendedor_prov_mxn).toBe(0);
    expect(p.totales.comision_vendedor_real_mxn).toBe(0);
    expect(Object.keys(p.totales).slice(-4)).toEqual([
      'comisiones_mxn',
      'comision_banco_avion_mxn',
      'comision_vendedor_prov_mxn',
      'comision_vendedor_real_mxn',
    ]);
    expect(p.totales.ganancia_mxn).toBe(39686.1);
    expect(p.totales.comision_vendedor_mxn).toBe(0);
    expect(p.balance.utilidad_antes_usd).toBe(p.totales.ganancia_usd);
    // Bandera raíz (invariante 61): viaja SIEMPRE, al final.
    expect(p.comision_vendedor_solo_gasto_real).toBe(true);
    expect(Object.keys(p).slice(-1)).toEqual([
      'comision_vendedor_solo_gasto_real',
    ]);
  });

  it('ANTES de la vigencia todo es el libro de siempre: sin llaves nuevas y SOLO cambian ganancia, cobrado real, la nota del cobro con comisión y la cascada', async () => {
    const antes = await libro(mundoLibros(), POSTERIOR);
    const fAntes = filaDe(antes.vuelos, V1);
    expect(fAntes.comisiones_mxn).toBeUndefined();
    expect(fAntes.comisiones_detalle).toBeUndefined();
    expect(fAntes.comision_banco_avion_mxn).toBeUndefined();
    expect(fAntes.comision_vendedor_prov_mxn).toBeUndefined();
    expect(fAntes.comision_vendedor_real_mxn).toBeUndefined();
    expect(fAntes.comision_vendedor_real_pagos).toBeUndefined();
    expect(fAntes.cobros.every((c) => !('neto_mxn' in c))).toBe(true);
    expect(fAntes.ganancia_mxn).toBe(fAntes.remanente_mxn);
    expect(fAntes.cobrado_real_mxn).toBe(40000);
    expect(fAntes.cobros[0].cobrado_con).toBeNull();
    expect('comisiones_mxn' in antes.totales).toBe(false);

    const con = await libro(mundoLibros(), DEFAULT);
    // El pendiente de captura del #501 solo existe en la vigencia; el resto
    // de los pendientes, idéntico.
    expect(
      con.pendientes.filter((x) => !x.includes(PENDIENTE_CAPTURA_501)),
    ).toEqual(antes.pendientes);
    expect(antes.pendientes.join(' | ')).not.toContain('sin pago capturado');
    // La bandera raíz (invariante 61) viaja también ANTES de la vigencia.
    expect(antes.comision_vendedor_solo_gasto_real).toBe(true);
    const sinPendientes = (p: BalanceAvionPayload) => ({
      ...sinSello(p),
      pendientes: null,
    });
    expect(
      diferencias(sinPendientes(antes), sinPendientes(con)).sort(),
    ).toEqual(
      [
        // API 0.0.66 (7-oct-2026): la cascada del general gana «antes de
        // comisiones» − COMISIONES (aditivos, solo con la regla).
        'balance.comisiones_usd',
        'balance.utilidad_antes_comisiones_usd',
        'balance.utilidad_antes_usd',
        'balance.utilidad_cobrada_usd',
        'balance.utilidad_despues_usd',
        'totales.cobrado_real_mxn',
        'totales.comision_banco_avion_mxn',
        'totales.comision_vendedor_prov_mxn',
        'totales.comision_vendedor_real_mxn',
        'totales.comisiones_mxn',
        'totales.ganancia_mxn',
        'totales.ganancia_usd',
        'vuelos.0.cobrado_real_mxn',
        'vuelos.0.cobros.0.cobrado_con',
        'vuelos.0.cobros.0.neto_mxn',
        'vuelos.0.cobros.1.neto_mxn',
        'vuelos.0.comision_banco_avion_mxn',
        'vuelos.0.comision_vendedor_prov_mxn',
        'vuelos.0.comision_vendedor_real_mxn',
        'vuelos.0.comision_vendedor_real_pagos',
        'vuelos.0.comisiones_detalle',
        'vuelos.0.comisiones_mxn',
        'vuelos.0.ganancia_mxn',
        'vuelos.0.ganancia_usd',
      ].sort(),
    );
  });

  it('el día de la vigencia (1-sep) aplica y el día anterior (31-ago) no', async () => {
    const enElDia = await libro(
      mundoCon({ v1: { fecha_vuelo: '2026-09-01T15:00:00+00:00' } }),
    );
    expect(filaDe(enElDia.vuelos, V1).comisiones_mxn).toBe(313.9);
    // 31-ago 23:00 Cancún = 1-sep 04:00 UTC: manda el DÍA CANCÚN.
    const a = armar(
      mundoCon({ v1: { fecha_vuelo: '2026-09-01T04:00:00+00:00' } }),
    );
    await a.service.xlsx(AV, '2026-08-01', HASTA);
    const f = filaDe(a.enviados.individual!.vuelos, V1);
    expect(f.comisiones_mxn).toBeUndefined();
    expect(f.ganancia_mxn).toBe(f.remanente_mxn);
  });

  it('vigencia a MITAD del periodo: solo los vuelos desde ese día (el #502 sin comisiones lleva la regla con COMISIONES vacía)', async () => {
    const m = mundoCon({ v2: vuelo2() });
    m.cobro_vuelo = [
      ...m.cobro_vuelo,
      {
        id: 'c-v2',
        vuelo_id: V2,
        monto: 1000,
        moneda: 'USD',
        tc_usd_mxn: 18,
        fecha_cobro: '2026-09-20T16:00:00+00:00',
        comision_banco_monto: null,
      },
    ];
    const p = await libro(m, '2026-09-11');
    const f1 = filaDe(p.vuelos, V1);
    const f2 = filaDe(p.vuelos, V2);
    expect(f1.comisiones_mxn).toBeUndefined();
    expect(f1.cobrado_real_mxn).toBe(40000);
    expect(f2.comisiones_mxn).toBeNull();
    expect(f2.comisiones_detalle).toEqual([]);
    expect(f2.comision_banco_avion_mxn).toBe(0);
    expect(f2.comision_vendedor_prov_mxn).toBe(0);
    expect(f2.comision_vendedor_real_mxn).toBe(0);
    expect(f2.comision_vendedor_real_pagos).toBe(0);
    expect(f2.ganancia_mxn).toBe(f2.remanente_mxn);
    expect(f2.cobros.map((c) => c.neto_mxn)).toEqual([18000]);
    expect(p.totales.comisiones_mxn).toBe(0);
  });

  it('la vigencia sale de la configuración `comisiones_al_avion_desde` (default 2026-09-01) y, sin ConfiguracionService, rige el default', async () => {
    const a = armar(mundoLibros());
    await a.service.xlsx(AV, DESDE, HASTA);
    expect(a.lecturas).toEqual([['comisiones_al_avion_desde', DEFAULT]]);
    const sinConfig = await libro(mundoLibros(), SIN_CONFIG);
    expect(filaDe(sinConfig.vuelos, V1).comisiones_mxn).toBe(313.9);
  });

  it('CANCELADO con dinero retenido: lo retenido es 100 % del avión ⇒ absorbe la comisión bancaria completa; la «(VuelaTour)» NO (la paga VuelaTour) y nunca hay pendiente de captura', async () => {
    for (const m of [
      mundoCon({ v1: { estado: 'CANCELADO' } }),
      conPago(1600, {}, { v1: { estado: 'CANCELADO' }, categoria: VUELATOUR }),
    ]) {
      const p = await libro(m);
      const f = filaDe(p.vuelos, V1);
      expect(f.comision_banco_avion_mxn).toBe(350);
      expect(f.comision_vendedor_prov_mxn).toBe(0);
      expect(f.comision_vendedor_real_mxn).toBe(0);
      expect(f.comision_vendedor_real_pagos).toBe(0);
      expect(f.comisiones_mxn).toBe(350);
      expect(f.comisiones_detalle).toEqual([
        'Comisión bancaria · $350.00 (parte del avión 100 %)',
      ]);
      expect(f.ganancia_mxn).toBe(r2((f.remanente_mxn ?? 0) - 350));
      expect(p.pendientes.join(' | ')).not.toContain('sin pago capturado');
    }
  });

  it('CANCELADO con dinero retenido + «(avión)» (13-oct-2026): el avión SÍ la carga — retuvo cobros, el reparto lee el vuelo — y la nota dice que no hubo comisión cobrada', async () => {
    const p = await libro(conPago(1600, {}, { v1: { estado: 'CANCELADO' } }));
    const f = filaDe(p.vuelos, V1);
    expect(f.comision_banco_avion_mxn).toBe(350);
    expect(f.comision_vendedor_real_mxn).toBe(1600);
    expect(f.comision_vendedor_real_pagos).toBe(1);
    expect(f.comisiones_mxn).toBe(1950);
    expect(f.comisiones_detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · $350.00 (parte del avión 100 %)',
      'Comisión vendedor (Vendedor Uno) · $1,600.00 · gasto real · vuelo cancelado: sin comisión cobrada',
    ]);
    expect(f.ganancia_mxn).toBe(r2((f.remanente_mxn ?? 0) - 1950));
    expect(p.pendientes.join(' | ')).not.toMatch(
      /sin pago capturado|que ningún avión carga/,
    );
  });

  it('IVA 16 %: el IVA cotizado ya no mueve COMISIONES (el pago real no depende de él); el pendiente de captura cita lo cotizado CON IVA (comisión + IVA = $92.80 USD)', async () => {
    // #501 con IVA: tiempo 2,000 + comisión 80, IVA (2,080 × 16 %) = 332.80.
    const v1 = {
      tuas_usd: 0,
      extras_total_usd: 0,
      iva_pct: 0.16,
      iva_usd: 332.8,
      monto_total_usd: 2412.8,
      monto_total_mxn: 48256,
    };
    const p = await libro(mundoCon({ v1 }));
    const f = filaDe(p.vuelos, V1);
    // Hasta el 0.0.73: provisión (80 + 12.80) × 20 = 1,856.
    expect(f.comision_vendedor_prov_mxn).toBe(0);
    expect(f.comision_vendedor_real_mxn).toBe(0);
    expect(
      p.pendientes.some((x) =>
        x.includes(
          'comisión del vendedor cotizada ($92.80 USD) sin pago capturado — captúralo en Gastos ligado a este vuelo como «Comisión del vendedor (avión)»',
        ),
      ),
    ).toBe(true);
    // Con un pago real de 1,700: resta 1,700 (ni 1,856 ni 1,600).
    const con = filaDe((await libro(conPago(1700, {}, { v1 }))).vuelos, V1);
    expect(con.comision_vendedor_real_mxn).toBe(1700);
    expect(con.comisiones_detalle).toContain(
      'Comisión vendedor (Vendedor Uno) · $1,700.00 · gasto real',
    );
  });
});

describe('Balance — COMISIONES en multi-avión y en EXTERNOS (API 0.0.65)', () => {
  it('MULTI-AVIÓN: cada libro absorbe SU parte (repartirUsd) y Σ de los dos == comisión × factor; el pago REAL del vendedor también se reparte (Σ == el gasto) y «otros movimientos» lo trae «a cargo de los aviones …» con egreso $0.00', async () => {
    const g = await general(mundoFlota());
    const fila = (gen: General, matricula: string) =>
      filaDe(gen.aviones.find((a) => a.matricula === matricula)!.vuelos, V3);
    const tst = fila(g, 'XB-TST');
    const dos = fila(g, 'XB-DOS');
    // 630.01 × 2,000/2,100 = 600.01 ⇒ 300.01 (principal) + 300.00.
    expect([
      tst.comision_banco_avion_mxn,
      dos.comision_banco_avion_mxn,
    ]).toEqual([300.01, 300]);
    // Sin gasto real el vendedor no resta en ninguno (hasta el 0.0.73: la
    // provisión de 100 USD × 18 = 1,800 ⇒ 900 + 900).
    expect([
      tst.comision_vendedor_real_mxn,
      dos.comision_vendedor_real_mxn,
    ]).toEqual([0, 0]);
    expect([tst.comisiones_mxn, dos.comisiones_mxn]).toEqual([300.01, 300]);
    expect(tst.comisiones_detalle).toEqual([
      'Comisión bancaria · $630.01 (parte del avión 47.62 %: $300.01)',
    ]);
    // El pendiente de captura sale UNA vez, en el avión que reporta.
    const pendientes = g.aviones.flatMap((a) =>
      a.pendientes.filter(
        (x) => x.includes('#503') && x.includes('sin pago capturado'),
      ),
    );
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]).toContain(
      'comisión del vendedor cotizada ($100.00 USD) sin pago capturado',
    );
    // CON un pago real de 1,801.01 MXN (centavo impar): 900.51 (principal) +
    // 900.50 (Σ == el gasto al centavo, repartirUsd) y la pestaña lo trae
    // en $0.00 (con «excede $1.01 MXN» contra lo cobrado: 100 USD × 18).
    const base = mundoFlota();
    const conPago3 = {
      ...base,
      gasto: [
        ...base.gasto,
        gastoComision(
          'g-cv-3',
          1801.01,
          {
            vuelo_id: V3,
            vuelo: { folio: 503, aeronave_id: AV },
            fecha_gasto: '2026-09-20',
          },
          AVION,
        ),
      ],
    };
    const gp = await general(conPago3);
    const tstP = fila(gp, 'XB-TST');
    const dosP = fila(gp, 'XB-DOS');
    expect([
      tstP.comision_vendedor_real_mxn,
      dosP.comision_vendedor_real_mxn,
    ]).toEqual([900.51, 900.5]);
    expect(
      r2(
        (tstP.comision_vendedor_real_mxn ?? 0) +
          (dosP.comision_vendedor_real_mxn ?? 0),
      ),
    ).toBe(1801.01);
    expect([
      tstP.comision_vendedor_real_pagos,
      dosP.comision_vendedor_real_pagos,
    ]).toEqual([1, 1]);
    expect(tstP.comisiones_detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · $630.01 (parte del avión 47.62 %: $300.01)',
      'Comisión vendedor (Pablo Canales) · $1,801.01 · gasto real (parte del avión 50 %: $900.51)',
    ]);
    const omP = omDe(gp, 503);
    expect(omP.nota_egreso).toContain(
      'pago comisión vendedor (Pablo Canales) · gasto real · excede $1.01 MXN · a cargo de los aviones ',
    );
    expect(omP.nota_egreso).toMatch(
      /a cargo de los aviones (XB-TST \(\$900\.51 en su columna COMISIONES\) y XB-DOS \(\$900\.50 en su columna COMISIONES\)|XB-DOS \(\$900\.50 en su columna COMISIONES\) y XB-TST \(\$900\.51 en su columna COMISIONES\)) = \$0\.00/,
    );
    // Egreso de la fila: solo la parte VuelaTour de la bancaria.
    expect([omP.ingreso_mxn, omP.egreso_mxn, omP.remanente_mxn]).toEqual([
      1800, 30, 1770,
    ]);
    // Cada fila: neto de SU parte del depósito (la que reporta lleva además
    // la parte de VuelaTour del depósito y de la comisión).
    expect(
      tst.cobros.map((c) => [c.monto_mxn, c.comision_mxn, c.neto_mxn]),
    ).toEqual([[19800, 330.01, 19469.99]]);
    expect(
      dos.cobros.map((c) => [c.monto_mxn, c.comision_mxn, c.neto_mxn]),
    ).toEqual([[18000, 300, 17700]]);
    // «Otros movimientos» SIN gasto real: VuelaTour solo paga su parte de la
    // comisión (630.01 − 600.01 = 30.00) y la fila NO lleva egreso del
    // vendedor (invariantes 58 y 61). Sin la línea de ingreso «a cargo del
    // avión» del 0.0.65.
    const om = omDe(g, 503);
    expect(om.nota_egreso).toContain(
      'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $30.00',
    );
    expect(`${om.concepto_egreso ?? ''}\n${om.nota_egreso ?? ''}`).not.toMatch(
      /pago comisi[oó]n vendedor|cubierto por|PROVISI[OÓ]N/,
    );
    expect(om.ingreso_mxn).toBe(1800);
    expect(om.egreso_mxn).toBe(30);
    expect(om.remanente_mxn).toBe(1770);
    expect(om.concepto_ingreso).not.toMatch(/a cargo del avión/);
  });

  it('EXTERNOS: lo que entró va en NETO, pero no hay avión que absorba comisiones (sin COMISIONES) y la comisión bancaria sigue COMPLETA en «otros movimientos»', async () => {
    const g = await general(mundoFlota());
    const ext = g.consolidado.vuelos.find((v) => v.vuelo_id === V4)!;
    expect(ext.es_externo).toBe(true);
    expect(ext.cobros.map((c) => [c.monto_mxn, c.neto_mxn])).toEqual([
      [18000, 17100],
    ]);
    expect(ext.cobrado_real_mxn).toBe(17100);
    expect('comisiones_mxn' in ext).toBe(false);
    expect(ext.ganancia_mxn).toBe(ext.remanente_mxn);
    const om = omDe(g, 504);
    expect(om.concepto_egreso).toBe('comisión bancaria');
    expect(om.egreso_mxn).toBe(900);
  });
});

describe('Balance GENERAL — COMISIONES en «otros movimientos», RESUMEN y bloque VUELATOUR (API 0.0.65)', () => {
  it('«otros movimientos» del #501 SIN gasto real: VuelaTour paga SOLO su parte de la comisión bancaria y la fila no lleva egreso del vendedor (invariantes 58 y 61)', async () => {
    const g = await general(mundoLibros());
    const om = omDe(g, 501);
    // Ingreso: comisión cobrada 1,600 + TUAS/extras 3,000 (UNA vez: el
    // 0.0.65 sumaba además 1,600 «a cargo del avión»). Egreso: TUAS 1,500 +
    // comisión bancaria de VuelaTour 36.10 (350 − 313.90); del pago al
    // vendedor, nada (hasta el 0.0.72 iba la línea «cubierto por el avión
    // … · PROVISIÓN … = $0.00»). Remanente: el del 0.0.65.
    expect(om.ingreso_mxn).toBe(4600);
    expect(om.egreso_mxn).toBe(1536.1);
    expect(om.remanente_mxn).toBe(3063.9);
    expect(om.concepto_ingreso).toBe(
      'comisión vendedor + TUAs con IVA · 2 conceptos (ver nota)',
    );
    expect(om.nota_ingreso).toBe(
      [
        'comisión vendedor (Vendedor Uno) = $1,600.00',
        'tuas/extras/pernocta cobrados + iva (sin desglose canónico: estimado con columnas) = $3,000.00',
      ].join('\n'),
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
    // Lo que VuelaTour gana de más en la pestaña respecto a la regla
    // anterior = la parte de la comisión BANCARIA que absorbe el avión
    // (313.90): sin gasto real no hay pago al vendedor en ningún libro.
    const golden = GOLDEN_OM.filas[0];
    const fila = filaDe(g.consolidado.vuelos, V1);
    expect(fila.comision_vendedor_prov_mxn).toBe(0);
    expect(fila.comision_vendedor_real_mxn).toBe(0);
    expect(r2((om.remanente_mxn ?? 0) - (golden.remanente_mxn ?? 0))).toBe(
      fila.comision_banco_avion_mxn,
    );
  });

  it('«otros movimientos» del #501 CON gasto real de $1,600: el avión lo carga en COMISIONES y la pestaña lo trae apareado con egreso $0.00 «a cargo del avión XB-TST ($1,600.00 en su columna COMISIONES)», con la fecha del pago; el remanente es el mismo que sin gasto (el pago no se cuenta dos veces)', async () => {
    const g = await general(conPago(1600, { fecha_gasto: '2026-09-28' }));
    const om = omDe(g, 501);
    expect(om.nota_egreso).toBe(
      [
        'pago comisión vendedor (Vendedor Uno) · gasto real · a cargo del avión XB-TST ($1,600.00 en su columna COMISIONES) = $0.00',
        'tuas pagadas = $1,500.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $36.10',
      ].join('\n'),
    );
    expect([om.ingreso_mxn, om.egreso_mxn, om.remanente_mxn]).toEqual([
      4600, 1536.1, 3063.9,
    ]);
    const fila = filaDe(g.consolidado.vuelos, V1);
    expect(fila.comision_vendedor_real_mxn).toBe(1600);
    expect(fila.comision_vendedor_real_pagos).toBe(1);
    // Nada de provisión ni de «cubierto por»; todos empiezan con «pago comisión vendedor».
    expect(`${om.concepto_egreso}\n${om.nota_egreso}`).not.toMatch(
      /PROVISI[OÓ]N|cubierto por|sin TC/,
    );
    expect(g.consolidado.otros_movimientos!.hay_pago_vendedor_real).toBe(true);
    // Sin otros egresos en el vuelo (mundo solo con la comisión): fila
    // directa, egreso 0 con la fecha del pago.
    const solo = conPago(1600, { fecha_gasto: '2026-09-28' });
    solo.vuelo = solo.vuelo.map((v) => ({
      ...v,
      tuas_usd: 0,
      extras_total_usd: 0,
      monto_total_usd: 2080,
      monto_total_mxn: 41600,
    }));
    solo.gasto = solo.gasto.filter((x) => x.id !== 'g-tuas');
    solo.cobro_vuelo = solo.cobro_vuelo.map((c) => ({
      ...c,
      comision_banco_monto: null,
    }));
    const directo = omDe(await general(solo), 501);
    expect(directo.concepto_egreso).toBe(
      'pago comisión vendedor (Vendedor Uno) · gasto real · a cargo del avión XB-TST ($1,600.00 en su columna COMISIONES)',
    );
    expect(directo.egreso_mxn).toBe(0);
    expect(directo.fecha_egreso).toBe('2026-09-28');
    expect(directo.remanente_mxn).toBe(directo.ingreso_mxn);
  });

  it('conservación del dinero (invariante 61): Σ ganancia de los libros + Σ remanente de «otros movimientos» == la regla anterior — cada pago real cuenta UNA vez (en el avión o en la pestaña) y la parte del avión de la bancaria solo cambia de bolsa', async () => {
    for (const m of [
      mundoLibros(),
      conPago(1600),
      conPago(2000),
      conPago(1600, {}, { categoria: VUELATOUR }),
    ]) {
      const con = await general(m);
      const antes = await general(m, POSTERIOR);
      expect(dineroTotal(con)).toBe(dineroTotal(antes));
      // Desglose explícito: lo que las filas restan de MÁS en COMISIONES
      // (la parte bancaria de la vigencia; la «(avión)» resta en las dos
      // reglas porque no depende de la vigencia) es EXACTAMENTE lo que la
      // pestaña deja de egresar.
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
  });

  it('ANTES de la vigencia la pestaña es la de siempre, byte a byte (golden sin gasto real)', async () => {
    const g = await general(mundoLibros(), POSTERIOR);
    expect(g.consolidado.otros_movimientos).toEqual(GOLDEN_OM);
  });

  it('CANCELADO: el avión absorbió la comisión completa ⇒ la pestaña no pinta egreso de comisión bancaria ni provisión que cobrar', async () => {
    const g = await general(mundoCon({ v1: { estado: 'CANCELADO' } }));
    const om = omDe(g, 501);
    expect(`${om.concepto_egreso ?? ''}\n${om.nota_egreso ?? ''}`).not.toMatch(
      /comisión bancaria/,
    );
    expect(om.concepto_ingreso ?? '').not.toMatch(/a cargo del avión/);
    expect(om.egreso_mxn).toBe(1500);
  });

  it('RESUMEN: COMISIONES del libro y GANANCIA = VENTA − COSTO − COMBUSTIBLE − COMISIONES', async () => {
    const g = await general(mundoLibros());
    const fila = g.resumen.find((r) => r.matricula === 'XB-TST')!;
    expect(fila.comisiones_mxn).toBe(313.9);
    // Gas del mes: 3,000.
    expect(fila.ganancia_mxn).toBe(r2(39686.1 - 3000));
    expect(fila.ganancia_mxn).toBe(
      r2(
        (fila.venta_mxn ?? 0) -
          (fila.costo_mxn ?? 0) -
          (fila.combustible_mxn ?? 0) -
          (fila.comisiones_mxn ?? 0),
      ),
    );
    expect(g.resumen_totales.comisiones_mxn).toBe(313.9);
    expect(g.consolidado.totales.comisiones_mxn).toBe(313.9);
    expect(g.consolidado.totales.comision_vendedor_real_mxn).toBe(0);
    // Con el pago real: COMISIONES del libro y de la flota = banco + pago.
    const conPagoG = await general(conPago(1600));
    expect(
      conPagoG.resumen.find((r) => r.matricula === 'XB-TST')!.comisiones_mxn,
    ).toBe(1913.9);
    expect(conPagoG.consolidado.totales.comision_vendedor_real_mxn).toBe(1600);
    expect(
      conPagoG.aviones.find((a) => a.matricula === 'XB-TST')!.totales
        .comision_vendedor_real_mxn,
    ).toBe(1600);
    // Antes de la vigencia, el 0 de siempre.
    const antes = await general(mundoLibros(), POSTERIOR);
    expect(
      antes.resumen.find((r) => r.matricula === 'XB-TST')!.comisiones_mxn,
    ).toBe(0);
    expect('comisiones_mxn' in antes.consolidado.totales).toBe(false);
  });

  it('bloque VUELATOUR: sus ingresos son lo cobrado al cliente (como antes de la regla), no provisiona el pago al vendedor en ninguna regla (invariante 58), paga solo su parte de la comisión bancaria y su participación como socia baja con la ganancia del avión', async () => {
    const conSocios = (): Record<string, Fila[]> => ({
      ...mundoLibros(),
      aeronave_socio: [
        socio(AV, 'u-mau', '71.000', 'Mauricio Roque', false),
        socio(AV, 'u-acc', '29.000', 'Aero Charter Cancun', true),
      ],
    });
    const antes = (await general(conSocios(), POSTERIOR)).empresa!;
    const con = (await general(conSocios())).empresa!;
    // API 0.0.66: sin la línea «a cargo del avión», los ingresos propios son
    // los de antes de la regla (el 0.0.65 sumaba +80 USD de provisión).
    expect(con.ingresos_propios_usd).toBe(antes.ingresos_propios_usd);
    // Egresos: solo −313.90 MXN ÷ 20 = 15.695 USD de la comisión bancaria
    // que absorbe el avión. La provisión del vendedor (80 USD) ya no egresa
    // antes NI después de la vigencia (invariante 58): hasta el 0.0.72 la
    // diferencia era 95.695 (80 de la provisión + 15.695).
    expect(antes.pagos_vendedor_usd! - con.pagos_vendedor_usd!).toBeCloseTo(
      15.695,
      1,
    );
    expect(con.participacion_usd!).toBeLessThan(antes.participacion_usd!);
  });

  it('bloque VUELATOUR con un pago «a cargo del avión»: `pagos_vendedor_usd` NO lo incluye (egreso 0), el resultado no se anula (la fila no lleva «sin TC») y la nota dice que lo carga el avión; la participación de la empresa como socia baja su % del pago (29 % × 80 USD)', async () => {
    const conSocios = (m: Record<string, Fila[]>): Record<string, Fila[]> => ({
      ...m,
      aeronave_socio: [
        socio(AV, 'u-mau', '71.000', 'Mauricio Roque', false),
        socio(AV, 'u-acc', '29.000', 'Aero Charter Cancun', true),
      ],
    });
    const sin = (await general(conSocios(mundoLibros()))).empresa!;
    const con = (await general(conSocios(conPago(1600)))).empresa!;
    expect(con.pagos_vendedor_usd).toBe(sin.pagos_vendedor_usd);
    expect(con.ingresos_propios_usd).toBe(sin.ingresos_propios_usd);
    expect(con.movimientos_sin_tc).toBe(0);
    expect(con.resultado_usd).not.toBeNull();
    expect(r2(sin.participacion_usd! - con.participacion_usd!)).toBe(23.2);
    expect(con.nota).toContain(
      'Egresos = pago al vendedor (solo los gastos reales capturados: la «Comisión del vendedor (VuelaTour)» egresa aquí; la «Comisión del vendedor (avión)» que carga un avión en su columna COMISIONES aquí egresa $0.00), TUAs pagadas',
    );
    expect(sin.nota).toContain(
      'Egresos = pago al vendedor (solo los gastos reales de comisión del vendedor capturados), TUAs pagadas',
    );
  });

  it('el general lee la vigencia UNA sola vez para todos sus libros', async () => {
    const a = armar(mundoFlota());
    await a.service.xlsxGeneral(DESDE, HASTA);
    expect(a.lecturas).toHaveLength(1);
  });
});

/**
 * Vuelos de la vigencia que AÚN NO se realizan (revisión 6-oct-2026), con
 * comisión del vendedor y K 18 (`vuelo2`):
 *  - #510 COTIZADO: 1,000 de tiempo + 150 de comisión, sin cobros.
 *  - #511 RESERVA: 1,000 + 100, sin cobros.
 *  - #512 CONFIRMADO: 1,000 + 50, sin cobros.
 *  - #513 CONFIRMADO con ANTICIPO: 1,000 + 80, cobro de 9,720 MXN con 486
 *    de comisión bancaria (factor 1,000/1,080 ⇒ 450 al avión).
 */
function mundoNoRealizados(conAnticipo = true): Record<string, Fila[]> {
  const m = mundoLibros();
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
      ...(conAnticipo ? [pendiente('v-13', 513, 'CONFIRMADO', '25', 80)] : []),
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      ...(conAnticipo
        ? [
            {
              id: 'c-13',
              vuelo_id: 'v-13',
              monto: 9720,
              moneda: 'MXN',
              tc_usd_mxn: 18,
              fecha_cobro: '2026-09-20T16:00:00+00:00',
              comision_banco_monto: 486,
            },
          ]
        : []),
    ],
  };
}

/**
 * #514 con la comisión BillPocket cobrada al cliente como EXTRA (desglose
 * v1.3): 1,000 de tiempo + 50 «Comisión BillPocket (sin IVA)» = 1,050 USD,
 * K 18, cobrado completo (18,900 MXN) con 945 de comisión bancaria ⇒ el
 * avión absorbe 945 × 1,000/1,050 = 900 y VuelaTour 45.
 */
function mundoBillPocket(): Record<string, Fila[]> {
  const m = mundoLibros();
  return {
    ...m,
    vuelo: [
      ...m.vuelo,
      vuelo2({
        id: 'v-14',
        folio: 514,
        fecha_vuelo: '2026-09-26T15:00:00+00:00',
        extras_total_usd: 50,
        monto_total_usd: 1050,
        monto_total_mxn: 18900,
        calculo_snapshot: {
          desglose: [
            {
              clave: 'TIEMPO_VUELO',
              concepto: 'Tiempo de vuelo · 1 hr × $1000/hr',
              monto_usd: 1000,
            },
            {
              clave: 'EXTRA',
              concepto: 'Comisión BillPocket (sin IVA)',
              monto_usd: 50,
            },
          ],
        },
      }),
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      {
        id: 'c-14',
        vuelo_id: 'v-14',
        monto: 18900,
        moneda: 'MXN',
        tc_usd_mxn: 18,
        fecha_cobro: '2026-09-26T20:00:00+00:00',
        comision_banco_monto: 945,
        metodo_cobro: 'BILLPOCKET',
      },
    ],
  };
}

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

describe('Balance — COMISIONES: revisión 6-oct-2026', () => {
  it('vuelos AÚN NO realizados (COTIZADO, RESERVA, CONFIRMADO): el avión no les carga el pago al vendedor (ni una «(avión)»: lo paga VuelaTour hasta que se complete, con su pendiente) ni avisa pendiente de captura — su venta la neutraliza POR COBRAR y la utilidad cobrada solo baja por las comisiones del #501', async () => {
    const base = mundoNoRealizados(false);
    // Un pago «(avión)» del #512 CONFIRMADO: fuera del universo, no lo
    // absorbe el avión.
    const mundo = {
      ...base,
      gasto: [
        ...base.gasto,
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
    const p = await libro(mundo);
    for (const id of ['v-10', 'v-11', 'v-12']) {
      const f = filaDe(p.vuelos, id);
      expect(f.comision_vendedor_prov_mxn).toBe(0);
      expect(f.comision_vendedor_real_mxn).toBe(0);
      expect(f.comision_vendedor_real_pagos).toBe(0);
      expect(f.comision_banco_avion_mxn).toBe(0);
      expect(f.comisiones_mxn).toBeNull();
      expect(f.comisiones_detalle).toEqual([]);
      expect(f.ganancia_mxn).toBe(f.remanente_mxn);
    }
    expect(p.totales.comisiones_mxn).toBe(313.9);
    // El pendiente de captura: solo el #501 (COMPLETADO de la vigencia).
    const capturas = p.pendientes.filter((x) =>
      x.includes('sin pago capturado'),
    );
    expect(capturas).toHaveLength(1);
    expect(capturas[0]).toContain('#501');
    // El «(avión)» del #512 CONFIRMADO: pendiente «que ningún avión carga».
    const sinCargo = p.pendientes.filter((x) =>
      x.includes('que ningún avión carga'),
    );
    expect(sinCargo).toHaveLength(1);
    expect(sinCargo[0]).toMatch(
      /^Vuelo #512 .*: gasto «Comisión del vendedor \(avión\)» que ningún avión carga \(el vuelo aún no se completa: al completarse lo cargará el avión\) — lo paga VuelaTour en 'otros movimientos' del Balance general; si el pago es de VuelaTour, reclasifícalo a «Comisión del vendedor \(VuelaTour\)»$/,
    );
    // La cascada: solo la comisión bancaria del #501 (15.70 USD ± el
    // redondeo de la ganancia USD de la fila; hasta el 0.0.73: 95.70 con la
    // provisión).
    const antes = await libro(mundo, POSTERIOR);
    expect(
      Math.abs(
        r2(
          (p.balance.utilidad_cobrada_usd ?? 0) -
            (antes.balance.utilidad_cobrada_usd ?? 0),
        ) + 15.7,
      ),
    ).toBeLessThan(0.02);
  });

  it('CONFIRMADO con anticipo: su comisión bancaria SÍ la absorbe el avión (sigue al cobro, que el balance cuenta) y el pago al vendedor no', async () => {
    const p = await libro(mundoNoRealizados());
    const f = filaDe(p.vuelos, 'v-13');
    expect(f.comision_banco_avion_mxn).toBe(450);
    expect(f.comision_vendedor_prov_mxn).toBe(0);
    expect(f.comision_vendedor_real_mxn).toBe(0);
    expect(f.comisiones_mxn).toBe(450);
    expect(f.comisiones_detalle).toEqual([
      'Comisión bancaria · $486.00 (parte del avión 92.59 %: $450.00)',
    ]);
    expect(f.cobros.map((c) => [c.monto_mxn, c.neto_mxn])).toEqual([
      [9720, 9234],
    ]);
    expect(p.totales.comisiones_mxn).toBe(r2(313.9 + 450));
  });

  it('«otros movimientos»: sin gasto real NADIE lleva egreso del vendedor (invariantes 58 y 61) — ni el #501 COMPLETADO ni los no realizados; el ingreso cobrado se queda; banderas raíz en individual, `aviones[]`, consolidado y pestaña', async () => {
    const g = await general(mundoNoRealizados());
    const egreso = (f: BalanceOtroMovimientoFilaPayload) =>
      `${f.concepto_egreso ?? ''}\n${f.nota_egreso ?? ''}`;
    for (const f of g.consolidado.otros_movimientos!.filas) {
      expect([
        f.clave,
        /pago comisi[oó]n vendedor|cubierto por|PROVISI[OÓ]N/.test(egreso(f)),
      ]).toEqual([f.clave, false]);
    }
    // #501: solo TUAS (1,500) + la parte VuelaTour de la comisión bancaria
    // (36.10); sin gasto real el avión tampoco resta nada del vendedor.
    const f501 = omDe(g, 501);
    expect([f501.ingreso_mxn, f501.egreso_mxn, f501.remanente_mxn]).toEqual([
      4600, 1536.1, 3063.9,
    ]);
    expect(filaDe(g.consolidado.vuelos, V1).comision_vendedor_prov_mxn).toBe(0);
    expect(filaDe(g.consolidado.vuelos, V1).comision_vendedor_real_mxn).toBe(0);
    // #510/#511/#512 (sin cobros): la comisión cotizada es su único
    // renglón, sin egreso alguno ⇒ remanente = ingreso.
    for (const [folio, comision] of [
      [510, 2700],
      [511, 1800],
      [512, 900],
    ] as const) {
      const f = omDe(g, folio);
      expect([folio, f.ingreso_mxn, f.concepto_egreso, f.egreso_mxn]).toEqual([
        folio,
        comision,
        null,
        null,
      ]);
      expect(f.remanente_mxn).toBe(comision);
    }
    // #513 (CONFIRMADO con anticipo): solo la parte VuelaTour de la comisión
    // bancaria del anticipo (486 − 450).
    const f513 = omDe(g, 513);
    expect([f513.ingreso_mxn, f513.egreso_mxn, f513.remanente_mxn]).toEqual([
      1440, 36, 1404,
    ]);
    expect(
      g.consolidado.otros_movimientos!.filas.some((f) =>
        `${f.concepto_ingreso ?? ''}\n${f.nota_ingreso ?? ''}`.includes(
          'a cargo del avión',
        ),
      ),
    ).toBe(false);
    expect(g.consolidado.otros_movimientos!.sin_provision_vendedor).toBe(true);
    // Bandera RAÍZ de `buildPayload` (la que activa en pyservices la nota
    // nueva del libro INDIVIDUAL): en cada `aviones[]` del general y en el
    // libro individual; el consolidado «FLOTA», armado a mano, no la lleva a
    // propósito (invariante 58).
    expect(g.aviones.length).toBeGreaterThan(0);
    expect(g.aviones.every((a) => a.sin_provision_vendedor === true)).toBe(
      true,
    );
    expect(g.consolidado).not.toHaveProperty('sin_provision_vendedor');
    const individual = await libro(mundoNoRealizados());
    expect(individual.sin_provision_vendedor).toBe(true);
    // FACTURA VUELATOUR según los cobros (13-oct-2026, invariante 60): la
    // bandera raíz viaja en el individual, en cada `aviones[]` Y en el
    // consolidado FLOTA (a diferencia de `sin_provision_vendedor`); la
    // pestaña «otros movimientos» no la lleva.
    expect(individual.factura_vuelatour_segun_cobros).toBe(true);
    expect(
      g.aviones.every((a) => a.factura_vuelatour_segun_cobros === true),
    ).toBe(true);
    expect(g.consolidado.factura_vuelatour_segun_cobros).toBe(true);
    expect(g.consolidado.otros_movimientos).not.toHaveProperty(
      'factura_vuelatour_segun_cobros',
    );
    // SOLO GASTO REAL (13-oct-2026, invariante 61): la bandera viaja en el
    // individual, en cada `aviones[]`, en el consolidado FLOTA (sus notas de
    // COMISIONES salen de él; a diferencia de `sin_provision_vendedor`) y en
    // la pestaña, después de `sin_provision_vendedor`.
    expect(individual.comision_vendedor_solo_gasto_real).toBe(true);
    expect(
      g.aviones.every((a) => a.comision_vendedor_solo_gasto_real === true),
    ).toBe(true);
    expect(g.consolidado.comision_vendedor_solo_gasto_real).toBe(true);
    const om = g.consolidado.otros_movimientos!;
    expect(om.comision_vendedor_solo_gasto_real).toBe(true);
    expect(Object.keys(om).slice(-2)).toEqual([
      'sin_provision_vendedor',
      'comision_vendedor_solo_gasto_real',
    ]);
  });

  it('comisión BillPocket cobrada al cliente: el egreso apareado de VuelaTour es SOLO su parte (comisión − parte del avión) y el dinero se conserva', async () => {
    const g = await general(mundoBillPocket());
    const f = filaDe(g.consolidado.vuelos, 'v-14');
    expect(f.comision_banco_avion_mxn).toBe(900);
    expect(f.comisiones_mxn).toBe(900);
    expect(f.comisiones_detalle).toEqual([
      'Comisión bancaria · BillPocket · $945.00 (parte del avión 95.24 %: $900.00)',
    ]);
    expect(f.ganancia_mxn).toBe(r2((f.remanente_mxn ?? 0) - 900));
    const om = omDe(g, 514);
    // Ingreso: la línea BillPocket cobrada (50 USD × 18); egreso: 945 − 900.
    expect(om.ingreso_mxn).toBe(900);
    expect(om.egreso_mxn).toBe(45);
    expect(om.remanente_mxn).toBe(855);
    expect(om.concepto_egreso).toBe(
      'comisión del banco (parte VuelaTour: la del avión va en su columna COMISIONES)',
    );
    // Antes de la vigencia: VuelaTour pagaba la comisión completa.
    const antes = await general(mundoBillPocket(), POSTERIOR);
    const omAntes = omDe(antes, 514);
    expect(omAntes.egreso_mxn).toBe(945);
    expect(omAntes.concepto_egreso).toBe('comisión del banco');
    // Conservación: lo que el avión absorbe de la comisión bancaria es lo
    // que VuelaTour deja de pagar y, sin gasto real, el vendedor no resta en
    // ningún libro (invariante 61; hasta el 0.0.73 la provisión del #501
    // restaba 1,600 solo en el avión) ⇒ Σ ganancia de los libros + Σ
    // remanente de «otros movimientos» == la regla anterior, al centavo.
    expect(filaDe(g.consolidado.vuelos, V1).comision_vendedor_prov_mxn).toBe(0);
    expect(dineroTotal(g)).toBe(dineroTotal(antes));
  });

  it('SOBRECOBRO: el avión absorbe la comisión SOLO de lo que le toca (cobrado al avión ÷ cobrado) y VuelaTour, que se queda el excedente, paga el resto', async () => {
    // #508: 1,000 USD de tiempo (todo del avión), K 18, cobrado 1,100 USD
    // con 33 USD de comisión (594 MXN) ⇒ 594 × 1,000/1,100 = 540 al avión.
    const m = mundoLibros();
    m.vuelo = [
      ...m.vuelo,
      vuelo2({
        id: 'v-8',
        folio: 508,
        fecha_vuelo: '2026-09-24T15:00:00+00:00',
      }),
    ];
    m.cobro_vuelo = [
      ...m.cobro_vuelo,
      {
        id: 'c-8',
        vuelo_id: 'v-8',
        monto: 1100,
        moneda: 'USD',
        tc_usd_mxn: 18,
        fecha_cobro: '2026-09-24T20:00:00+00:00',
        comision_banco_monto: 33,
      },
    ];
    const g = await general(m);
    const f = filaDe(g.consolidado.vuelos, 'v-8');
    expect(f.comision_banco_avion_mxn).toBe(540);
    expect(f.comisiones_detalle).toEqual([
      'Comisión bancaria · $33.00 USD = $594.00 (parte del avión 90.91 %: $540.00)',
    ]);
    // Lo cobrado AL AVIÓN sigue topado en su venta (por cobrar 0).
    expect(f.cobrado_mxn).toBe(18000);
    expect(f.por_cobrar_mxn).toBe(0);
    const om = omDe(g, 508);
    expect(om.nota_egreso ?? om.concepto_egreso).toContain(
      'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES)',
    );
    expect(om.egreso_mxn).toBe(54);
    // El dinero se conserva contra la regla anterior al centavo (desde el
    // 0.0.74 ya no hay provisión del vendedor que reste solo en el avión).
    expect(dineroTotal(g)).toBe(dineroTotal(await general(m, POSTERIOR)));
  });

  it('vuelo SIN T.C. capturado: K = T.C. oficial del día de la cotización para el pago real y las comisiones USD sin T.C. propio (la misma cadena del reparto); sin NINGÚN T.C. el pago USD no entra en pesos y el pendiente lo dice', async () => {
    // #501 sin T.C. en la cotización (oficial 18.75), un cobro de 100 USD
    // sin T.C. propio con 5 USD de comisión y un pago real de 80 USD sin
    // tc_gasto.
    const m = conPago(
      80,
      { moneda: 'USD', tc_gasto: null },
      {
        v1: {
          tc_usd_mxn: null,
          monto_total_mxn: null,
          fecha_solicitud: '2026-09-01T15:00:00+00:00',
        },
      },
    );
    m.cobro_vuelo = [
      ...m.cobro_vuelo,
      {
        id: 'c-3',
        vuelo_id: V1,
        monto: 100,
        moneda: 'USD',
        tc_usd_mxn: null,
        fecha_cobro: '2026-09-12T18:00:00+00:00',
        comision_banco_monto: 5,
      },
    ];
    const a = armar(m, undefined, 18.75);
    await a.service.xlsx(AV, DESDE, HASTA);
    const p = a.enviados.individual!;
    const f = filaDe(p.vuelos, V1);
    expect(f.tc_venta).toBe(18.75);
    // 80 USD × 18.75 (hasta el 0.0.73 era la provisión; hoy el pago real).
    expect(f.comision_vendedor_real_mxn).toBe(1500);
    expect(f.comision_vendedor_prov_mxn).toBe(0);
    // 350 × 2,000/2,230 = 313.90 + round2(5 × 18.75) × 2,000/2,230 = 84.08.
    expect(f.comision_banco_avion_mxn).toBe(397.98);
    expect(f.comisiones_mxn).toBe(1897.98);
    expect(f.comisiones_detalle).toContain(
      'Comisión vendedor (Vendedor Uno) · $1,500.00 · gasto real',
    );
    expect(
      p.pendientes.some((x) =>
        x.includes(
          'pago al vendedor «Comisión del vendedor (avión)» en USD sin T.C.',
        ),
      ),
    ).toBe(false);
    // «Otros movimientos»: la comisión cobrada sigue como ingreso con el
    // MISMO K (80 × 18.75) y el pago sale «a cargo del avión» con $0.00.
    const g = await general(m, undefined, 18.75);
    const om = omDe(g, 501);
    expect(om.nota_ingreso).toContain(
      'comisión vendedor (Vendedor Uno) = $1,500.00',
    );
    // 350 + round2(5 × 18.75) = 443.75 de comisión; 397.98 del avión.
    expect(om.nota_egreso).toBe(
      [
        'pago comisión vendedor (Vendedor Uno) · gasto real · a cargo del avión XB-TST ($1,500.00 en su columna COMISIONES) = $0.00',
        'tuas pagadas = $1,500.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $45.77',
      ].join('\n'),
    );
    expect(om.egreso_mxn).toBe(1545.77);
    // SIN NINGÚN T.C. (ni tc_gasto, ni K, ni oficial): el pago USD no llega
    // a pesos ⇒ no entra a COMISIONES y el pendiente lo grita con el texto
    // del 0.0.74 (el reparto sí lo resta en USD).
    const sinTc = armar(m, undefined, null);
    await sinTc.service.xlsx(AV, DESDE, HASTA);
    const ps = sinTc.enviados.individual!;
    const fs = filaDe(ps.vuelos, V1);
    expect(fs.comision_vendedor_real_mxn).toBe(0);
    expect(fs.comision_vendedor_real_pagos).toBe(1);
    expect(fs.comisiones_detalle).toContain(
      'Comisión vendedor (Vendedor Uno) · $80.00 USD sin T.C. — no suma en pesos',
    );
    expect(
      ps.pendientes.filter((x) =>
        x.endsWith(
          ': pago al vendedor «Comisión del vendedor (avión)» en USD sin T.C. (ni tc_gasto ni T.C. de venta) — no entra a COMISIONES en pesos; en el reparto sí resta en USD (captura el T.C. del gasto o el de la cotización)',
        ),
      ),
    ).toHaveLength(1);
    // La pestaña del general: «a cargo del avión» SIN cifra en pesos.
    const gs = await general(m, undefined, null);
    const omS = omDe(gs, 501);
    expect(`${omS.concepto_egreso ?? ''}\n${omS.nota_egreso ?? ''}`).toContain(
      'pago comisión vendedor (Vendedor Uno) · gasto real · a cargo del avión XB-TST (sin T.C. no entra en pesos a su columna COMISIONES; resta en USD en su reparto)',
    );
  });
});

/**
 * DOS CATEGORÍAS DEL PAGO AL VENDEDOR (13-oct-2026, invariante 61; pedido
 * del cliente: «necesitamos una opcion que sea Comision del vendedor pero que
 * esa opcion si se cargue al balance del avión, y dejamos el otro que se va a
 * balance de vuelatour»). La «(VuelaTour)» la paga SIEMPRE VuelaTour (byte a
 * byte con el 0.0.73 en la pestaña); la «(avión)» la carga el avión en su
 * universo (COMPLETADO o CANCELADO con cobros retenidos), en cualquier fecha,
 * y si nadie la carga la paga VuelaTour con el motivo en el concepto y un
 * pendiente en el libro que reporta.
 */
describe('Balance — dos categorías de la comisión del vendedor (13-oct-2026)', () => {
  const egresos = (f: BalanceOtroMovimientoFilaPayload) =>
    `${f.concepto_egreso ?? ''}\n${f.nota_egreso ?? ''}`;

  it('«(VuelaTour)» en un COMPLETADO de la vigencia: COMISIONES solo banco, y la pestaña la egresa con la rama de siempre (byte a byte 0.0.73)', async () => {
    const m = conPago(
      1600,
      { fecha_gasto: '2026-09-28' },
      { categoria: VUELATOUR },
    );
    const p = await libro(m);
    const f = filaDe(p.vuelos, V1);
    expect([
      f.comision_banco_avion_mxn,
      f.comision_vendedor_real_mxn,
      f.comision_vendedor_real_pagos,
      f.comisiones_mxn,
    ]).toEqual([313.9, 0, 0, 313.9]);
    expect(f.comisiones_detalle).toEqual([
      'Comisión bancaria · $350.00 (parte del avión 89.69 %: $313.90)',
    ]);
    // Hay pago (de VuelaTour): ni pendiente de captura ni «sin cargo».
    expect(p.pendientes.join(' | ')).not.toMatch(
      /sin pago capturado|que ningún avión carga/,
    );
    const g = await general(m);
    const om = omDe(g, 501);
    expect(om.nota_egreso).toBe(
      [
        'pago comisión vendedor (Vendedor Uno) · gasto real = $1,600.00',
        'tuas pagadas = $1,500.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $36.10',
      ].join('\n'),
    );
    expect([om.ingreso_mxn, om.egreso_mxn, om.remanente_mxn]).toEqual([
      4600, 3136.1, 1463.9,
    ]);
    // La nota del bloque VUELATOUR: sin «(avión)» absorbida, la corta.
    expect(g.empresa?.nota ?? '').not.toContain(
      'que carga un avión en su columna COMISIONES',
    );
  });

  it('MIXTO (1,000 «(VuelaTour)» + 600 «(avión)»): cada pago a su lado — el avión resta 600, la pestaña egresa 1,000 con «· VuelaTour $1,000.00 · a cargo del avión …»', async () => {
    const m = mundoCon({
      gastos: [
        gastoComision('g-vt', 1000, { fecha_gasto: '2026-09-27' }, VUELATOUR),
        gastoComision('g-av', 600, { fecha_gasto: '2026-09-28' }, AVION),
      ],
    });
    const f = filaDe((await libro(m)).vuelos, V1);
    expect(f.comision_vendedor_real_mxn).toBe(600);
    expect(f.comision_vendedor_real_pagos).toBe(1);
    expect(f.comisiones_mxn).toBe(913.9);
    expect(f.comisiones_detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · $350.00 (parte del avión 89.69 %: $313.90)',
      'Comisión vendedor (Vendedor Uno) · $600.00 · gasto real',
    ]);
    const g = await general(m);
    const om = omDe(g, 501);
    expect(om.nota_egreso).toBe(
      [
        'pago comisión vendedor (Vendedor Uno) · gasto real (2 pagos) · VuelaTour $1,000.00 · a cargo del avión XB-TST ($600.00 en su columna COMISIONES) = $1,000.00',
        'tuas pagadas = $1,500.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $36.10',
      ].join('\n'),
    );
    expect([om.ingreso_mxn, om.egreso_mxn, om.remanente_mxn]).toEqual([
      4600, 2536.1, 2063.9,
    ]);
    // Conservación: el dinero total es el de la regla anterior al centavo.
    expect(dineroTotal(g)).toBe(dineroTotal(await general(m, POSTERIOR)));
  });

  it('CANCELADO con cobros retenidos + «(avión)»: el avión la carga y la pestaña la pinta INFORMATIVA (sin línea: «vuelo cancelado: sin comisión cobrada · a cargo del avión …» = $0.00)', async () => {
    const m = conPago(
      1600,
      { fecha_gasto: '2026-09-28' },
      { v1: { estado: 'CANCELADO' } },
    );
    const g = await general(m);
    const om = omDe(g, 501);
    expect(egresos(om)).toContain(
      'pago comisión vendedor (Vendedor Uno) · vuelo cancelado: sin comisión cobrada · a cargo del avión XB-TST ($1,600.00 en su columna COMISIONES) = $0.00',
    );
    // El egreso de la fila no cambia por el pago (lo carga el avión).
    expect(om.egreso_mxn).toBe(1500);
    expect(egresos(om)).not.toMatch(/sin TC|PROVISI[OÓ]N/);
    expect(filaDe(g.consolidado.vuelos, V1).comision_vendedor_real_pagos).toBe(
      1,
    );
  });

  it('CANCELADO SIN cobros + «(avión)»: nadie la carga — la pestaña la egresa con el motivo y el libro avisa el pendiente', async () => {
    const m = conPago(
      1600,
      { fecha_gasto: '2026-09-28' },
      { v1: { estado: 'CANCELADO' } },
    );
    m.cobro_vuelo = m.cobro_vuelo.filter((c) => c.vuelo_id !== V1);
    const p = await libro(m);
    const sinCargo = p.pendientes.filter((x) =>
      x.includes('que ningún avión carga'),
    );
    expect(sinCargo).toHaveLength(1);
    expect(sinCargo[0]).toContain(
      ": gasto «Comisión del vendedor (avión)» que ningún avión carga (vuelo cancelado sin cobros retenidos) — lo paga VuelaTour en 'otros movimientos' del Balance general; si el pago es de VuelaTour, reclasifícalo a «Comisión del vendedor (VuelaTour)»",
    );
    const g = await general(m);
    const om = omDe(g, 501);
    expect(egresos(om)).toContain(
      'pago comisión vendedor (Vendedor Uno) · vuelo cancelado: sin comisión cobrada · incluye «Comisión del vendedor (avión)» que ningún avión carga (vuelo cancelado sin cobros retenidos): la paga VuelaTour = $1,600.00',
    );
    expect(om.egreso_mxn).toBe(3100);
  });

  it('CONFIRMADO + «(avión)»: la paga VuelaTour con el motivo (y «faltan» contra lo cobrado) y el libro lo avisa', async () => {
    const base = mundoNoRealizados(false);
    const m = {
      ...base,
      gasto: [
        ...base.gasto,
        gastoComision(
          'g-cv-512',
          500,
          {
            vuelo_id: 'v-12',
            vuelo: { folio: 512, aeronave_id: AV },
            fecha_gasto: '2026-09-27',
          },
          AVION,
        ),
      ],
    };
    const g = await general(m);
    const om = omDe(g, 512);
    expect(om.concepto_egreso).toBe(
      'pago comisión vendedor (Saab) · gasto real · parcial: faltan $400.00 MXN · incluye «Comisión del vendedor (avión)» que ningún avión carga (el vuelo aún no se completa: al completarse lo cargará el avión): la paga VuelaTour',
    );
    expect([om.ingreso_mxn, om.egreso_mxn, om.remanente_mxn]).toEqual([
      900, 500, 400,
    ]);
    expect(
      filaDe(g.consolidado.vuelos, 'v-12').comision_vendedor_real_pagos,
    ).toBe(0);
  });

  it('EXTERNOS (sin avión de la flota) + «(avión)»: pendiente «vuelo sin avión de la flota» en su libro y la pestaña la egresa con ese motivo', async () => {
    const base = mundoFlota();
    const m = {
      ...base,
      gasto: [
        ...base.gasto,
        gastoComision(
          'g-cv-504',
          700,
          {
            vuelo_id: V4,
            aeronave_id: null,
            vuelo: { folio: 504, aeronave_id: null },
            fecha_gasto: '2026-09-19',
          },
          AVION,
        ),
      ],
    };
    const ext = armar(m);
    await ext.service.xlsx(null as unknown as string, DESDE, HASTA);
    const libroExt = ext.enviados.individual!;
    expect(libroExt.matricula).toBe('EXTERNOS');
    const pend = libroExt.pendientes.filter((x) =>
      x.includes('que ningún avión carga'),
    );
    expect(pend).toHaveLength(1);
    expect(pend[0]).toContain(
      'gasto «Comisión del vendedor (avión)» que ningún avión carga (vuelo sin avión de la flota)',
    );
    const g = await general(m);
    const om = omDe(g, 504);
    expect(egresos(om)).toContain(
      'pago comisión vendedor · sin comisión cobrada en la cotización · incluye «Comisión del vendedor (avión)» que ningún avión carga (vuelo sin avión de la flota): la paga VuelaTour = $700.00',
    );
  });

  it('EXTERNO CON avión de referencia + «(avión)»: lo carga ese avión (balance y reparto le dan factor 1)', async () => {
    const m = conPago(
      1600,
      {},
      {
        v1: {
          es_externo: true,
          operador_externo: 'XA-TYV',
          costo_externo_usd: 500,
        },
      },
    );
    const f = filaDe((await libro(m)).vuelos, V1);
    expect(f.comision_vendedor_real_mxn).toBe(1600);
    expect(f.comision_vendedor_real_pagos).toBe(1);
  });

  it('ANTES de la vigencia: una «(avión)» absorbida hace nacer las llaves (banco 0), los totales y `balance.comisiones_usd`; sin ella el libro sale byte a byte', async () => {
    const antes = await libro(conPago(1600), POSTERIOR);
    const f = filaDe(antes.vuelos, V1);
    expect(f.comision_banco_avion_mxn).toBe(0);
    expect(f.comision_vendedor_real_mxn).toBe(1600);
    expect(f.comision_vendedor_real_pagos).toBe(1);
    expect(f.comisiones_mxn).toBe(1600);
    expect(f.comisiones_detalle).toEqual([
      'Comisión vendedor (Vendedor Uno) · $1,600.00 · gasto real',
    ]);
    // R1 (neto de cada cobro) sigue siendo SOLO de la vigencia.
    expect(f.cobros.every((c) => !('neto_mxn' in c))).toBe(true);
    expect(f.ganancia_mxn).toBe(r2((f.remanente_mxn ?? 0) - 1600));
    expect(antes.totales.comisiones_mxn).toBe(1600);
    expect(antes.totales.comision_vendedor_real_mxn).toBe(1600);
    expect(antes.totales.comision_banco_avion_mxn).toBe(0);
    expect(antes.balance.comisiones_usd).toBe(80);
    // Sin «(avión)» (aunque haya una «(VuelaTour)»): el libro de siempre.
    const sinAvion = await libro(
      conPago(1600, {}, { categoria: VUELATOUR }),
      POSTERIOR,
    );
    const base = await libro(mundoLibros(), POSTERIOR);
    expect(diferencias(sinSello(sinAvion), sinSello(base))).toEqual([]);
  });

  it('MULTI-AVIÓN: la «(avión)» se reparte por participación (Σ == el pago) y la pestaña dice «a cargo de los aviones …»; la «(VuelaTour)» del mismo vuelo egresa aparte', async () => {
    const base = mundoFlota();
    const m = {
      ...base,
      gasto: [
        ...base.gasto,
        gastoComision(
          'g-av-503',
          1000.01,
          {
            vuelo_id: V3,
            vuelo: { folio: 503, aeronave_id: AV },
            fecha_gasto: '2026-09-20',
          },
          AVION,
        ),
        gastoComision(
          'g-vt-503',
          800,
          {
            vuelo_id: V3,
            vuelo: { folio: 503, aeronave_id: AV },
            fecha_gasto: '2026-09-21',
          },
          VUELATOUR,
        ),
      ],
    };
    const g = await general(m);
    const fila = (matricula: string) =>
      filaDe(g.aviones.find((a) => a.matricula === matricula)!.vuelos, V3);
    const tst = fila('XB-TST');
    const dos = fila('XB-DOS');
    expect(
      r2(
        (tst.comision_vendedor_real_mxn ?? 0) +
          (dos.comision_vendedor_real_mxn ?? 0),
      ),
    ).toBe(1000.01);
    const om = omDe(g, 503);
    expect(om.nota_egreso).toMatch(
      /^pago comisión vendedor \(Pablo Canales\) · gasto real \(2 pagos\) · VuelaTour \$800\.00 · a cargo de los aviones .* = \$800\.00$/m,
    );
    // Egreso: 800 de VuelaTour + 30 de su parte de la bancaria.
    expect(om.egreso_mxn).toBe(830);
  });
});
