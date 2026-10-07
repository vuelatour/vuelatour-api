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
  DESDE,
  GOLDEN_OM,
  HASTA,
  V1,
  V2,
  fakeSupabase,
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
 * Mundo de los libros: vuelo #501 (XB-TST, 10-sep, K 20) de 2,230 USD =
 * 2,000 de tiempo + 100 TUAS + 50 extras + 80 de comisión del vendedor (sin
 * IVA) ⇒ factor del avión 2,000/2,230; cobros: 20,000 MXN con comisión
 * bancaria de 350 y 1,000 USD sin comisión.
 *  - BANCO: 350 × 0.896861 = 313.90 al avión (36.10 de VuelaTour).
 *  - VENDEDOR: provisión 80 USD × 20 = 1,600.
 *  - COMISIONES 1,913.90 ⇒ ganancia 40,000 − 1,913.90 = 38,086.10.
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
  it('fila del #501: COMISIONES = parte del avión de la comisión bancaria + provisión del vendedor; la ganancia queda después de ellas', async () => {
    const p = await libro(mundoLibros());
    const f = filaDe(p.vuelos, V1);
    expect(f.remanente_mxn).toBe(40000);
    expect(f.comision_banco_avion_mxn).toBe(313.9);
    expect(f.comision_vendedor_prov_mxn).toBe(1600);
    expect(f.comisiones_mxn).toBe(1913.9);
    expect(f.comisiones_detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · $350.00 (parte del avión 89.69 %: $313.90)',
      'Comisión vendedor (Vendedor Uno) · $1,600.00 · provisión = cotizado (sin IVA)',
    ]);
    expect(f.ganancia_mxn).toBe(38086.1);
    expect(f.ganancia_usd).toBe(r2(38086.1 / 20));
    // La columna vieja sigue null (compatibilidad de shape).
    expect(f.comision_vendedor_mxn).toBeNull();
    // Lo COBRADO AL AVIÓN no cambia de cálculo (bruto × factor) y un vuelo
    // pagado sigue dando su por cobrar de siempre.
    expect(f.cobrado_mxn).toBe(r2(r2(2000 * (2000 / 2230)) * 20));
    expect(f.por_cobrar_mxn).toBe(r2(40000 - f.cobrado_mxn));
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
    expect(Object.keys(f).slice(-5)).toEqual([
      'factura_vuelatour',
      'comisiones_mxn',
      'comisiones_detalle',
      'comision_banco_avion_mxn',
      'comision_vendedor_prov_mxn',
    ]);
    expect(p.totales.comisiones_mxn).toBe(1913.9);
    expect(p.totales.comision_banco_avion_mxn).toBe(313.9);
    expect(p.totales.comision_vendedor_prov_mxn).toBe(1600);
    expect(p.totales.ganancia_mxn).toBe(38086.1);
    expect(p.totales.comision_vendedor_mxn).toBe(0);
    expect(p.balance.utilidad_antes_usd).toBe(p.totales.ganancia_usd);
  });

  it('ANTES de la vigencia todo es el libro de siempre: sin llaves nuevas y SOLO cambian ganancia, cobrado real, la nota del cobro con comisión y la cascada', async () => {
    const antes = await libro(mundoLibros(), POSTERIOR);
    const fAntes = filaDe(antes.vuelos, V1);
    expect(fAntes.comisiones_mxn).toBeUndefined();
    expect(fAntes.comisiones_detalle).toBeUndefined();
    expect(fAntes.comision_banco_avion_mxn).toBeUndefined();
    expect(fAntes.comision_vendedor_prov_mxn).toBeUndefined();
    expect(fAntes.cobros.every((c) => !('neto_mxn' in c))).toBe(true);
    expect(fAntes.ganancia_mxn).toBe(fAntes.remanente_mxn);
    expect(fAntes.cobrado_real_mxn).toBe(40000);
    expect(fAntes.cobros[0].cobrado_con).toBeNull();
    expect('comisiones_mxn' in antes.totales).toBe(false);

    const con = await libro(mundoLibros(), DEFAULT);
    expect(diferencias(sinSello(antes), sinSello(con)).sort()).toEqual(
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
        'totales.comisiones_mxn',
        'totales.ganancia_mxn',
        'totales.ganancia_usd',
        'vuelos.0.cobrado_real_mxn',
        'vuelos.0.cobros.0.cobrado_con',
        'vuelos.0.cobros.0.neto_mxn',
        'vuelos.0.cobros.1.neto_mxn',
        'vuelos.0.comision_banco_avion_mxn',
        'vuelos.0.comision_vendedor_prov_mxn',
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
    expect(filaDe(enElDia.vuelos, V1).comisiones_mxn).toBe(1913.9);
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
    expect(f2.ganancia_mxn).toBe(f2.remanente_mxn);
    expect(f2.cobros.map((c) => c.neto_mxn)).toEqual([18000]);
    expect(p.totales.comisiones_mxn).toBe(0);
  });

  it('la vigencia sale de la configuración `comisiones_al_avion_desde` (default 2026-09-01) y, sin ConfiguracionService, rige el default', async () => {
    const a = armar(mundoLibros());
    await a.service.xlsx(AV, DESDE, HASTA);
    expect(a.lecturas).toEqual([['comisiones_al_avion_desde', DEFAULT]]);
    const sinConfig = await libro(mundoLibros(), SIN_CONFIG);
    expect(filaDe(sinConfig.vuelos, V1).comisiones_mxn).toBe(1913.9);
  });

  it('CANCELADO con dinero retenido: lo retenido es 100 % del avión ⇒ absorbe la comisión bancaria completa y NO hay provisión del vendedor', async () => {
    const p = await libro(mundoCon({ v1: { estado: 'CANCELADO' } }));
    const f = filaDe(p.vuelos, V1);
    expect(f.comision_banco_avion_mxn).toBe(350);
    expect(f.comision_vendedor_prov_mxn).toBe(0);
    expect(f.comisiones_mxn).toBe(350);
    expect(f.comisiones_detalle).toEqual([
      'Comisión bancaria · $350.00 (parte del avión 100 %)',
    ]);
    expect(f.ganancia_mxn).toBe(r2((f.remanente_mxn ?? 0) - 350));
  });

  it('IVA 16 %: la provisión es la comisión + su IVA al K del vuelo', async () => {
    // #501 con IVA: tiempo 2,000 + comisión 80, IVA (2,080 × 16 %) = 332.80.
    const p = await libro(
      mundoCon({
        v1: {
          tuas_usd: 0,
          extras_total_usd: 0,
          iva_pct: 0.16,
          iva_usd: 332.8,
          monto_total_usd: 2412.8,
          monto_total_mxn: 48256,
        },
      }),
    );
    const f = filaDe(p.vuelos, V1);
    // 80 + 12.80 = 92.80 USD × 20.
    expect(f.comision_vendedor_prov_mxn).toBe(1856);
    expect(f.comisiones_detalle).toContain(
      'Comisión vendedor (Vendedor Uno) · $1,856.00 · provisión = cotizado + IVA',
    );
  });
});

describe('Balance — COMISIONES en multi-avión y en EXTERNOS (API 0.0.65)', () => {
  it('MULTI-AVIÓN: cada libro absorbe SU parte (repartirUsd) y Σ de los dos == comisión × factor; la provisión del vendedor también se reparte', async () => {
    const g = await general(mundoFlota());
    const fila = (matricula: string) =>
      filaDe(g.aviones.find((a) => a.matricula === matricula)!.vuelos, V3);
    const tst = fila('XB-TST');
    const dos = fila('XB-DOS');
    // 630.01 × 2,000/2,100 = 600.01 ⇒ 300.01 (principal) + 300.00.
    expect([
      tst.comision_banco_avion_mxn,
      dos.comision_banco_avion_mxn,
    ]).toEqual([300.01, 300]);
    // 100 USD × 18 = 1,800 ⇒ 900 + 900.
    expect([
      tst.comision_vendedor_prov_mxn,
      dos.comision_vendedor_prov_mxn,
    ]).toEqual([900, 900]);
    expect([tst.comisiones_mxn, dos.comisiones_mxn]).toEqual([1200.01, 1200]);
    expect(tst.comisiones_detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · $630.01 (parte del avión 47.62 %: $300.01)',
      'Comisión vendedor (Pablo Canales) · $1,800.00 · provisión = cotizado (sin IVA) (parte del avión 50 %: $900.00)',
    ]);
    // Cada fila: neto de SU parte del depósito (la que reporta lleva además
    // la parte de VuelaTour del depósito y de la comisión).
    expect(
      tst.cobros.map((c) => [c.monto_mxn, c.comision_mxn, c.neto_mxn]),
    ).toEqual([[19800, 330.01, 19469.99]]);
    expect(
      dos.cobros.map((c) => [c.monto_mxn, c.comision_mxn, c.neto_mxn]),
    ).toEqual([[18000, 300, 17700]]);
    // «Otros movimientos»: VuelaTour solo paga su parte de la comisión
    // (630.01 − 600.01 = 30.00) y el pago al vendedor lo cubren los dos
    // aviones con SU provisión (API 0.0.66: sin la línea de ingreso «a
    // cargo del avión» del 0.0.65).
    const om = omDe(g, 503);
    expect(om.nota_egreso).toContain(
      'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $30.00',
    );
    expect(om.nota_egreso).toContain(
      'pago comisión vendedor (Pablo Canales) · cubierto por los aviones XB-DOS (provisión $900.00 en su balance) y XB-TST (provisión $900.00 en su balance) = $0.00',
    );
    expect(om.ingreso_mxn).toBe(1800);
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
  it('«otros movimientos» del #501: VuelaTour paga SOLO su parte de la comisión bancaria y el pago al vendedor lo cubre la provisión del avión (API 0.0.66)', async () => {
    const g = await general(mundoLibros());
    const om = omDe(g, 501);
    // Ingreso: comisión cobrada 1,600 + TUAS/extras 3,000 (UNA vez: el
    // 0.0.65 sumaba además 1,600 «a cargo del avión»). Egreso: el pago al
    // vendedor que cubre la provisión de XB-TST (0) + TUAS 1,500 + comisión
    // bancaria de VuelaTour 36.10 (350 − 313.90). Remanente: el del 0.0.65.
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
    expect(om.nota_egreso).toBe(
      [
        'pago comisión vendedor (Vendedor Uno) · cubierto por el avión XB-TST (provisión $1,600.00 en su balance) = $0.00',
        'tuas pagadas = $1,500.00',
        'comisión bancaria (parte VuelaTour: la del avión va en su columna COMISIONES) = $36.10',
      ].join('\n'),
    );
    // Lo que VuelaTour gana de más en la pestaña = lo que el avión absorbe.
    const golden = GOLDEN_OM.filas[0];
    expect(r2((om.remanente_mxn ?? 0) - (golden.remanente_mxn ?? 0))).toBe(
      filaDe(g.consolidado.vuelos, V1).comisiones_mxn,
    );
  });

  it('ANTES de la vigencia la pestaña es la de siempre, byte a byte (golden 0.0.38)', async () => {
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
    expect(fila.comisiones_mxn).toBe(1913.9);
    // Gas del mes: 3,000.
    expect(fila.ganancia_mxn).toBe(r2(38086.1 - 3000));
    expect(fila.ganancia_mxn).toBe(
      r2(
        (fila.venta_mxn ?? 0) -
          (fila.costo_mxn ?? 0) -
          (fila.combustible_mxn ?? 0) -
          (fila.comisiones_mxn ?? 0),
      ),
    );
    expect(g.resumen_totales.comisiones_mxn).toBe(1913.9);
    expect(g.consolidado.totales.comisiones_mxn).toBe(1913.9);
    // Antes de la vigencia, el 0 de siempre.
    const antes = await general(mundoLibros(), POSTERIOR);
    expect(
      antes.resumen.find((r) => r.matricula === 'XB-TST')!.comisiones_mxn,
    ).toBe(0);
    expect('comisiones_mxn' in antes.consolidado.totales).toBe(false);
  });

  it('bloque VUELATOUR: sus ingresos son lo cobrado al cliente (como antes de la regla), ya no paga la provisión del vendedor (la cubre el avión), paga solo su parte de la comisión bancaria y su participación como socia baja con la ganancia del avión', async () => {
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
    // Egresos: −80 USD de la provisión (la cubre XB-TST) − 313.90 MXN ÷ 20 =
    // 15.695 USD de la comisión bancaria que absorbe el avión.
    expect(antes.pagos_vendedor_usd! - con.pagos_vendedor_usd!).toBeCloseTo(
      95.695,
      1,
    );
    expect(con.participacion_usd!).toBeLessThan(antes.participacion_usd!);
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
  it('vuelos AÚN NO realizados (COTIZADO, RESERVA, CONFIRMADO): sin provisión del vendedor — su venta la neutraliza POR COBRAR y la utilidad cobrada solo baja por las comisiones del #501', async () => {
    const p = await libro(mundoNoRealizados(false));
    for (const id of ['v-10', 'v-11', 'v-12']) {
      const f = filaDe(p.vuelos, id);
      expect(f.comision_vendedor_prov_mxn).toBe(0);
      expect(f.comision_banco_avion_mxn).toBe(0);
      expect(f.comisiones_mxn).toBeNull();
      expect(f.comisiones_detalle).toEqual([]);
      expect(f.ganancia_mxn).toBe(f.remanente_mxn);
    }
    expect(p.totales.comisiones_mxn).toBe(1913.9);
    // La cascada: solo las comisiones del #501 (95.70 USD ± el redondeo
    // de la ganancia USD de la fila).
    const antes = await libro(mundoNoRealizados(false), POSTERIOR);
    expect(
      Math.abs(
        r2(
          (p.balance.utilidad_cobrada_usd ?? 0) -
            (antes.balance.utilidad_cobrada_usd ?? 0),
        ) + 95.7,
      ),
    ).toBeLessThan(0.02);
  });

  it('CONFIRMADO con anticipo: su comisión bancaria SÍ la absorbe el avión (sigue al cobro, que el balance cuenta) y la provisión no', async () => {
    const p = await libro(mundoNoRealizados());
    const f = filaDe(p.vuelos, 'v-13');
    expect(f.comision_banco_avion_mxn).toBe(450);
    expect(f.comision_vendedor_prov_mxn).toBe(0);
    expect(f.comisiones_mxn).toBe(450);
    expect(f.comisiones_detalle).toEqual([
      'Comisión bancaria · $486.00 (parte del avión 92.59 %: $450.00)',
    ]);
    expect(f.cobros.map((c) => [c.monto_mxn, c.neto_mxn])).toEqual([
      [9720, 9234],
    ]);
    expect(p.totales.comisiones_mxn).toBe(r2(1913.9 + 450));
  });

  it('«otros movimientos»: solo en el #501 (COMPLETADO) el avión cubre el pago al vendedor; los no realizados conservan su PROVISIÓN (API 0.0.66)', async () => {
    const g = await general(mundoNoRealizados());
    const egreso = (f: BalanceOtroMovimientoFilaPayload) =>
      `${f.concepto_egreso ?? ''}\n${f.nota_egreso ?? ''}`;
    const cubiertos = g.consolidado
      .otros_movimientos!.filas.filter((f) =>
        egreso(f).includes('cubierto por el avión'),
      )
      .map((f) => f.clave);
    expect(cubiertos).toHaveLength(1);
    expect(cubiertos[0].endsWith('501')).toBe(true);
    for (const folio of [510, 511, 512, 513]) {
      expect(egreso(omDe(g, folio))).toContain('PROVISIÓN');
    }
    expect(
      g.consolidado.otros_movimientos!.filas.some((f) =>
        `${f.concepto_ingreso ?? ''}\n${f.nota_ingreso ?? ''}`.includes(
          'a cargo del avión',
        ),
      ),
    ).toBe(false);
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
    // Conservación: lo que el avión absorbe es lo que VuelaTour deja de
    // pagar (y la provisión del #501 va y viene) — Σ ganancia de los libros
    // + Σ remanente de «otros movimientos» == la regla anterior.
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
    // El dinero se conserva contra la regla anterior.
    expect(dineroTotal(g)).toBe(dineroTotal(await general(m, POSTERIOR)));
  });

  it('vuelo SIN T.C. capturado: K = T.C. oficial del día de la cotización para la provisión y las comisiones USD sin T.C. propio (la misma cadena del reparto)', async () => {
    // #501 sin T.C. en la cotización (oficial 18.75) y un cobro de 100 USD
    // sin T.C. propio con 5 USD de comisión.
    const m = mundoCon({
      v1: {
        tc_usd_mxn: null,
        monto_total_mxn: null,
        fecha_solicitud: '2026-09-01T15:00:00+00:00',
      },
    });
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
    // 80 USD × 18.75.
    expect(f.comision_vendedor_prov_mxn).toBe(1500);
    // 350 × 2,000/2,230 = 313.90 + round2(5 × 18.75) × 2,000/2,230 = 84.08.
    expect(f.comision_banco_avion_mxn).toBe(397.98);
    expect(f.comisiones_mxn).toBe(1897.98);
    expect(f.comisiones_detalle).toContain(
      'Comisión vendedor (Vendedor Uno) · $1,500.00 · provisión = cotizado (sin IVA)',
    );
    expect(
      p.pendientes.some((x) => x.includes('comisión del vendedor sin TC')),
    ).toBe(false);
    // «Otros movimientos»: el pago al vendedor lo cubre la MISMA provisión
    // de la fila (API 0.0.66).
    const g = await general(m, undefined, 18.75);
    expect(omDe(g, 501).nota_egreso).toContain(
      'pago comisión vendedor (Vendedor Uno) · cubierto por el avión XB-TST (provisión $1,500.00 en su balance) = $0.00',
    );
  });
});
