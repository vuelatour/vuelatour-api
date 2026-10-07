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
  BalanceEmpresaBloquePayload,
  BalanceHojaOtrosMovimientosPayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  INGRESOS_LIBROS,
  V2,
  fakeSupabase,
  gastoBase,
  mundoLibros,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * BLOQUE «VUELATOUR (empresa)» al final de la hoja «balance» del Balance
 * general (6-oct-2026, API 0.0.59). Pedido del cliente: «en la hoja de
 * balance falta, hasta el final, el balance de la empresa VuelaTour».
 *
 * Contrato: `empresa` = participación como socia (el `monto_usd` de los
 * socios `es_empresa` de cada bloque) + ingresos − egresos de «otros
 * movimientos» (cada fila a USD con SU T.C.: el K del vuelo; una suelta, el
 * T.C. que la convirtió o el oficial del día) − el TOTAL USD exacto de la
 * hoja «otros gastos» + la utilidad de la tienda ÷ T.C. promedio.
 */

const AV2 = 'av-2';
/** XB-ANU: la empresa socia al 30 % y SIN vuelos (caso real de oct-2026). */
const AV3 = 'av-3';
const avionSinVuelos: Fila = {
  id: AV3,
  matricula: 'XB-ANU',
  modelo: 'C206',
  color_calendario: '#F59E0B',
  permiso_afac_usd_hr: null,
  servicio_intervalos: [],
  servicio_horas_base: 0,
};
const EMPRESA = 'Aero Charter Cancun S.A. de C.V.';
/** T.C. oficial que contesta el fake para CUALQUIER día. */
const TC_OFICIAL = 25;
/**
 * Vigencia de las COMISIONES A CARGO DEL AVIÓN (API 0.0.65) POSTERIOR a los
 * vuelos de septiembre de este mundo: aquí se prueba el bloque de siempre
 * (pre-vigencia, byte a byte). El bloque con la regla vive en
 * `aircraft-balance.service.comisiones.spec`.
 */
const CONFIG_VIGENCIA_POSTERIOR = {
  fecha: () => Promise.resolve('2026-12-01'),
};

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

const SOCIOS_CON_EMPRESA: Fila[] = [
  socio(AV, 'u-mau', '71.000', 'Mauricio Roque', false),
  socio(AV, 'u-acc', '29.000', EMPRESA, true),
  socio(AV2, 'u-acc', '100.000', EMPRESA, true),
];

/**
 * El mundo de los libros (XB-TST con el vuelo #501, K 20, y las filas
 * sueltas de siempre) + los 4 ingresos (2 de resultado) + un 2.º avión
 * XB-DOS con el vuelo #502 (K 18, sin conceptos de VuelaTour).
 */
function mundoEmpresa(
  opts: { socios?: Fila[]; ingresos?: Fila[]; gastos?: Fila[] } = {},
): Record<string, Fila[]> {
  const m = mundoLibros(opts.ingresos ?? INGRESOS_LIBROS);
  const f2 = '2026-09-20T15:00:00+00:00';
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
    vuelo: [...m.vuelo, vuelo2({ aeronave_id: AV2 })],
    escala: [
      ...m.escala,
      {
        id: 'e-2',
        vuelo_id: V2,
        orden: 1,
        aeronave_id: null,
        cancelada_at: null,
        taco_salida: 200,
        taco_llegada: 201,
        solo_operativa: false,
        es_ferry: false,
        origen_iata: 'CUN',
        destino_iata: 'CZM',
        es_sobrevuelo: false,
        tipo_parada: 'NORMAL',
        pasajeros: 2,
        fecha_salida_plan: f2,
        vuelo: { fecha_vuelo: f2, aeronave_id: AV2 },
      },
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      {
        id: 'c-3',
        vuelo_id: V2,
        monto: 1000,
        moneda: 'USD',
        tc_usd_mxn: 18,
        fecha_cobro: f2,
        comision_banco_monto: null,
      },
    ],
    gasto: [...m.gasto, ...(opts.gastos ?? [])],
    aeronave_socio: opts.socios ?? SOCIOS_CON_EMPRESA,
  };
}

function armar(
  mundo: Record<string, Fila[]>,
  opts: {
    tcOficial?: number | null;
    inventario?: unknown;
    /** T.C. oficial POR DÍA (gana sobre `tcOficial`). */
    oficial?: (dia: string) => number | null;
  } = {},
) {
  const f = fakeSupabase(mundo);
  const enviados: {
    individual?: BalanceAvionPayload;
    general?: General;
  } = {};
  const diasOficiales: string[] = [];
  const tcOficial = opts.tcOficial === undefined ? TC_OFICIAL : opts.tcOficial;
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
      oficialDetallePara: (dia: string) => {
        diasOficiales.push(dia);
        const tc = opts.oficial ? opts.oficial(dia) : tcOficial;
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    {
      resumenTiendita: () => Promise.resolve(opts.inventario ?? { items: [] }),
    } as never,
    CONFIG_VIGENCIA_POSTERIOR as never,
  );
  return { service, enviados, diasOficiales };
}

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  gastos_empresa: { total_mxn: number; usd: number | null };
  empresa?: BalanceEmpresaBloquePayload;
};

async function general(
  mundo: Record<string, Fila[]>,
  opts: Parameters<typeof armar>[1] = {},
) {
  const a = armar(mundo, opts);
  await a.service.xlsxGeneral(DESDE, HASTA);
  return { g: a.enviados.general!, diasOficiales: a.diasOficiales };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

describe('Balance por avión — `es_empresa` en los socios (6-oct-2026)', () => {
  it('cada socio del bloque lleva `es_empresa` (true solo la empresa)', async () => {
    const { service, enviados } = armar(mundoEmpresa());
    await service.xlsx(AV, DESDE, HASTA);
    const socios = enviados.individual!.balance.socios;
    expect(socios.map((s) => [s.nombre, s.porcentaje, s.es_empresa])).toEqual([
      ['Mauricio Roque', 71, false],
      [EMPRESA, 29, true],
    ]);
  });
});

describe('Balance GENERAL — bloque «VUELATOUR (empresa)» (6-oct-2026)', () => {
  it('socia en 2 aviones: participaciones = las celdas MONTO USD de cada bloque, Σ redondeada', async () => {
    const { g } = await general(mundoEmpresa());
    const e = g.empresa!;
    expect(g.aviones.map((a) => a.matricula)).toEqual(['XB-DOS', 'XB-TST']);
    const celdas = g.aviones.flatMap((a) =>
      a.balance.socios
        .filter((s) => s.es_empresa)
        .map((s) => ({
          matricula: a.matricula,
          socio: s.nombre,
          porcentaje: s.porcentaje,
          monto_usd: s.monto_usd,
        })),
    );
    expect(celdas).toHaveLength(2);
    expect(celdas.every((c) => typeof c.monto_usd === 'number')).toBe(true);
    expect(e.participaciones).toEqual(celdas);
    expect(e.participaciones.map((p) => [p.matricula, p.porcentaje])).toEqual([
      ['XB-DOS', 100],
      ['XB-TST', 29],
    ]);
    expect(e.participacion_usd).toBe(
      r2(celdas.reduce((s, c) => s + (c.monto_usd ?? 0), 0)),
    );
    // El socio que NO es la empresa no entra.
    expect(JSON.stringify(e.participaciones)).not.toContain('Mauricio');
  });

  it('otros movimientos (filas y sueltas): cada fila regresa a USD con SU T.C.', async () => {
    const { g, diasOficiales } = await general(mundoEmpresa());
    const e = g.empresa!;
    // Fila #501 (K 20): ingreso 4,600 ⇒ 230; egreso 3,450 ⇒ 172.50.
    // Sueltas en pesos con el oficial de su día (25): TUAS 80 ⇒ 3.20,
    // gas 250 ⇒ 10.00, ING-12 5,000 ⇒ 200 y su comisión 50 ⇒ 2.00.
    // ING-13 en USD con SU T.C. 18.5: 1,850 ⇒ 100.
    expect(e.ingresos_propios_usd).toBe(530);
    expect(e.pagos_vendedor_usd).toBe(187.7);
    expect(e.movimientos_sin_tc).toBe(0);
    // #501 cobró 2,000 de 2,230 USD: la parte de VuelaTour (230) cobrada
    // es 2,000 − round2(2,000 × 2,000/2,230) = 206.28 ⇒ 23.72 por cobrar
    // (informativo: el ingreso de la hoja es lo cotizado y NO se resta).
    expect(e.ingresos_por_cobrar_usd).toBe(23.72);
    expect(e.vuelos_por_cobrar).toBe(1);
    expect(e.nota).toContain(
      'De esos ingresos, $23.72 USD de 1 vuelo(s) aún están por cobrar.',
    );
    // Solo los días de las sueltas en PESOS (gasto 10-sep, ING-12 15-sep);
    // ING-13 trae su T.C. y los vuelos su K: nadie más pide el oficial.
    expect([...new Set(diasOficiales)].sort()).toEqual([
      '2026-09-10',
      '2026-09-15',
    ]);
  });

  it('otros gastos = EXACTAMENTE el TOTAL USD de la hoja «otros gastos» y el T.C. de la flota', async () => {
    const { g } = await general(mundoEmpresa());
    const e = g.empresa!;
    const tcFlota = g.consolidado.totales.tc_promedio;
    expect(tcFlota).toBe(19); // promedio de XB-TST (20) y XB-DOS (18)
    expect(e.otros_gastos_empresa_usd).toBe(g.gastos_empresa.usd);
    expect(e.otros_gastos_empresa_usd).toBe(r2(700 / 19));
    expect(e.tc_usado).toBe(tcFlota);
    expect(e.tc_promedio).toBe(tcFlota);
  });

  it('sin inventario: tienda null y el resultado no la suma', async () => {
    const { g } = await general(mundoEmpresa());
    const e = g.empresa!;
    expect(e.tienda_utilidad_usd).toBeNull();
    expect(e.resultado_usd).toBe(
      r2(
        e.participacion_usd! +
          e.ingresos_propios_usd! -
          e.pagos_vendedor_usd! -
          e.otros_gastos_empresa_usd!,
      ),
    );
    expect(e.nota).toContain('Tienda: sin inventario en el periodo.');
  });

  it('con inventario: utilidad de la tienda ÷ el MISMO T.C. promedio y suma al resultado', async () => {
    const { g } = await general(mundoEmpresa(), {
      inventario: {
        filas: [],
        total_utilidad_mxn: 1900,
        total_utilidad_usd: null,
      },
    });
    const e = g.empresa!;
    expect(e.tienda_utilidad_usd).toBe(100); // 1,900 ÷ 19
    expect(e.resultado_usd).toBe(
      r2(
        e.participacion_usd! +
          e.ingresos_propios_usd! -
          e.pagos_vendedor_usd! -
          e.otros_gastos_empresa_usd! +
          100,
      ),
    );
  });

  it('sin socio empresa: participación 0 y lista vacía (el resto del bloque sigue)', async () => {
    const { g } = await general(
      mundoEmpresa({
        socios: [socio(AV, 'u-mau', '100.000', 'Mauricio Roque', false)],
      }),
    );
    const e = g.empresa!;
    expect(e.participaciones).toEqual([]);
    expect(e.participacion_usd).toBe(0);
    expect(e.ingresos_propios_usd).toBe(530);
    expect(e.resultado_usd).toBe(r2(530 - 187.7 - e.otros_gastos_empresa_usd!));
    expect(e.nota).toContain('no es socia de ningún avión');
  });

  it('sin T.C. oficial del día: las sueltas en pesos regresan con el promedio de la pestaña', async () => {
    const { g } = await general(mundoEmpresa(), { tcOficial: null });
    const e = g.empresa!;
    // T.C. promedio de «otros movimientos» = (20 + 18) / 2 = 19.
    expect(e.ingresos_propios_usd).toBe(r2(230 + 5000 / 19 + 100));
    expect(e.pagos_vendedor_usd).toBe(r2(172.5 + (80 + 250 + 50) / 19));
  });

  it('un gasto suelto en USD regresa con SU T.C. (el que lo llevó a pesos), no con el oficial', async () => {
    const { g } = await general(
      mundoEmpresa({
        gastos: [
          {
            ...gastoBase,
            id: 'g-gas-usd',
            categoria: 'GAS',
            moneda: 'USD',
            tc_gasto: 17,
            monto: 10,
          },
        ],
      }),
    );
    const om = g.consolidado.otros_movimientos!;
    expect(om.filas_sueltas.some((s) => s.egreso_mxn === 170)).toBe(true);
    // 187.70 de siempre + los 10 USD exactos (170 ÷ 17), no 170 ÷ 25.
    expect(g.empresa!.pagos_vendedor_usd).toBe(197.7);
  });

  it('una fila sin T.C. deja su lado y el resultado VACÍOS (jamás un número que omite dinero)', async () => {
    const ingresoUsdSinTc: Fila = {
      ...INGRESOS_LIBROS[1],
      id: 'i-9',
      folio: 19,
      tc_usd_mxn: null,
    };
    const { g } = await general(
      mundoEmpresa({ ingresos: [...INGRESOS_LIBROS, ingresoUsdSinTc] }),
    );
    const e = g.empresa!;
    expect(e.ingresos_propios_usd).toBeNull();
    expect(e.pagos_vendedor_usd).toBe(187.7);
    expect(e.movimientos_sin_tc).toBe(1);
    expect(e.resultado_usd).toBeNull();
  });

  it('regla de la base: el ingreso es lo COTIZADO (un vuelo COTIZADO sin cobros suma) y su parte por cobrar viaja aparte', async () => {
    const mundo = mundoEmpresa();
    mundo.vuelo.push(
      vuelo2({
        id: 'v-cot',
        folio: 504,
        aeronave_id: AV2,
        estado: 'COTIZADO',
        subtotal_vuelo_usd: 1000,
        tuas_usd: 50,
        monto_total_usd: 1050,
        monto_total_mxn: 18900,
        tc_usd_mxn: 18,
      }),
      // #505: le faltan 0.50 USD — dentro de la tolerancia de redondeo de
      // `pendienteCobro` (≤ 1 USD no es deuda): nada por cobrar.
      vuelo2({
        id: 'v-casi',
        folio: 505,
        aeronave_id: AV2,
        estado: 'CONFIRMADO',
        subtotal_vuelo_usd: 1000,
        tuas_usd: 50,
        monto_total_usd: 1050,
        monto_total_mxn: 18900,
        tc_usd_mxn: 18,
      }),
    );
    mundo.cobro_vuelo.push({
      id: 'c-casi',
      vuelo_id: 'v-casi',
      monto: 1049.5,
      moneda: 'USD',
      tc_usd_mxn: 18,
      fecha_cobro: '2026-09-20T16:00:00+00:00',
      comision_banco_monto: null,
    });
    const { g } = await general(mundo);
    const e = g.empresa!;
    // 530 de siempre + el TUA cotizado del #504 y del #505 (50 USD × 18 ÷ 18
    // cada uno).
    expect(e.ingresos_propios_usd).toBe(630);
    // 23.72 del #501 + los 50 del #504 (sin un solo cobro); el #505 no.
    expect(e.ingresos_por_cobrar_usd).toBe(73.72);
    expect(e.vuelos_por_cobrar).toBe(2);
    // Informativo: el resultado NO lo resta.
    expect(e.resultado_usd).toBe(
      r2(
        e.participacion_usd! +
          630 -
          e.pagos_vendedor_usd! -
          e.otros_gastos_empresa_usd!,
      ),
    );
    expect(e.nota).toContain('Ingresos = lo COTIZADO');
    expect(e.nota).toContain('COTIZADO y RESERVA incluidos');
  });

  it('un vuelo SIN K (sin T.C., sin oficial, sin pesos de la cotización) regresa su egreso con el promedio de la pestaña', async () => {
    const mundo = mundoEmpresa({
      gastos: [
        {
          ...gastoBase,
          id: 'g-tua-sin-k',
          vuelo_id: 'v-sin-k',
          vuelo: { folio: 503, aeronave_id: AV2 },
          categoria: 'TUAS',
          monto: 190,
        },
      ],
    });
    mundo.vuelo.push(
      vuelo2({
        id: 'v-sin-k',
        folio: 503,
        aeronave_id: AV2,
        tc_usd_mxn: null,
        monto_total_mxn: null,
      }),
    );
    const { g } = await general(mundo, { tcOficial: null });
    const om = g.consolidado.otros_movimientos!;
    expect(om.filas.some((f) => f.egreso_mxn === 190)).toBe(true);
    // Promedio de la pestaña = (20 + 18) / 2 = 19 (el vuelo sin K no
    // cuenta): #501 172.50 + TUA 190 ÷ 19 = 10 + sueltas (80 + 250 + 50) ÷
    // 19 = 20. Sin el respaldo, la fila saldría «sin T.C.» y el lado null.
    expect(g.empresa!.pagos_vendedor_usd).toBe(202.5);
    expect(g.empresa!.movimientos_sin_tc).toBe(0);
  });

  it('T.C. de la FLOTA ≠ promedio de la pestaña: otros gastos y tienda con el de la flota; sueltas sin oficial con el de la pestaña', async () => {
    const { g } = await general(
      mundoEmpresa({
        gastos: [
          {
            ...gastoBase,
            id: 'g-op-v2',
            vuelo_id: V2,
            aeronave_id: AV2,
            vuelo: { folio: 502, aeronave_id: AV2 },
            categoria: 'OPERACIONES',
            monto: 340,
            tc_gasto: 17,
          },
        ],
      }),
      {
        tcOficial: null,
        inventario: {
          filas: [],
          total_utilidad_mxn: 1850,
          total_utilidad_usd: null,
        },
      },
    );
    const e = g.empresa!;
    // Flota = (Z de XB-TST 20 + Z de XB-DOS 17) / 2 = 18.5; la pestaña sigue
    // en (K 20 + K 18) / 2 = 19.
    expect(g.consolidado.totales.tc_promedio).toBe(18.5);
    expect(e.tc_usado).toBe(18.5);
    expect(e.otros_gastos_empresa_usd).toBe(r2(700 / 18.5));
    expect(e.otros_gastos_empresa_usd).toBe(g.gastos_empresa.usd);
    expect(e.tienda_utilidad_usd).toBe(100); // 1,850 ÷ 18.5
    // Sueltas en pesos sin oficial: (80 + 250 + 50) ÷ 19 = 20.
    expect(e.pagos_vendedor_usd).toBe(192.5);
    expect(e.ingresos_propios_usd).toBe(r2(230 + 5000 / 19 + 100));
  });

  it('avión con la empresa de socia SIN vuelos y con un PERMISO: sus hojas van con el oficial del cierre y el bloque NO se vacía', async () => {
    const mundo = mundoEmpresa({
      socios: [
        ...SOCIOS_CON_EMPRESA,
        socio(AV3, 'u-mau', '70.000', 'Mauricio Roque', false),
        socio(AV3, 'u-acc', '30.000', EMPRESA, true),
      ],
      gastos: [
        {
          ...gastoBase,
          id: 'g-permiso-anu',
          aeronave_id: AV3,
          categoria: 'PERMISO',
          monto: 2549,
        },
      ],
    });
    mundo.aeronave.push(avionSinVuelos);
    const { g } = await general(mundo);
    const anu = g.aviones.find((a) => a.matricula === 'XB-ANU')!;
    expect(anu.vuelos).toHaveLength(0);
    expect(anu.totales.tc_promedio).toBe(TC_OFICIAL);
    expect(anu.permisos.usd).toBe(r2(2549 / TC_OFICIAL)); // 101.96
    expect(anu.balance.utilidad_cobrada_usd).toBe(-101.96);
    expect(
      anu.balance.socios.map((s) => [s.nombre, s.es_empresa, s.monto_usd]),
    ).toEqual([
      ['Mauricio Roque', false, r2(0.7 * -101.96)],
      [EMPRESA, true, r2(0.3 * -101.96)],
    ]);
    expect(
      anu.pendientes.some((t) =>
        t.includes(
          'Avión XB-ANU: sin vuelos en el periodo — sus hojas de gastos se convirtieron a USD con el T.C. oficial de referencia',
        ),
      ),
    ).toBe(true);
    // El T.C. de la FLOTA sigue siendo el de los vuelos (20 y 18).
    expect(g.consolidado.totales.tc_promedio).toBe(19);
    const e = g.empresa!;
    expect(e.participaciones.map((p) => [p.matricula, p.monto_usd])).toEqual([
      ['XB-ANU', r2(0.3 * -101.96)],
      ['XB-DOS', expect.any(Number)],
      ['XB-TST', expect.any(Number)],
    ]);
    expect(e.participacion_usd).not.toBeNull();
    expect(e.resultado_usd).not.toBeNull();
  });

  it('el respaldo es SOLO para aviones sin vuelos: con un vuelo sin T.C. las hojas siguen vacías (jamás una utilidad que omite la venta)', async () => {
    const mundo = mundoEmpresa({
      gastos: [
        {
          ...gastoBase,
          id: 'g-permiso-dos',
          aeronave_id: AV2,
          categoria: 'PERMISO',
          monto: 2549,
        },
      ],
    });
    mundo.vuelo = mundo.vuelo.map((v) =>
      v.id === V2 ? { ...v, tc_usd_mxn: null, monto_total_mxn: null } : v,
    );
    // Sin oficial el día del vuelo #502 (20-sep); el del cierre sí existe.
    const { g } = await general(mundo, {
      oficial: (dia) => (dia === '2026-09-20' ? null : TC_OFICIAL),
    });
    const dos = g.aviones.find((a) => a.matricula === 'XB-DOS')!;
    expect(dos.vuelos).toHaveLength(1);
    expect(dos.totales.tc_promedio).toBeNull();
    expect(dos.permisos.usd).toBeNull();
    expect(dos.balance.utilidad_cobrada_usd).toBeNull();
    expect(
      dos.pendientes.some((t) => t.includes('sin vuelos en el periodo — sus')),
    ).toBe(false);
  });

  it('avión sin vuelos y SIN T.C. oficial: participación y resultado vacíos y la nota NOMBRA el avión', async () => {
    const mundo = mundoEmpresa({
      socios: [
        ...SOCIOS_CON_EMPRESA,
        socio(AV3, 'u-acc', '30.000', EMPRESA, true),
      ],
      gastos: [
        {
          ...gastoBase,
          id: 'g-permiso-anu',
          aeronave_id: AV3,
          categoria: 'PERMISO',
          monto: 2549,
        },
      ],
    });
    mundo.aeronave.push(avionSinVuelos);
    const { g } = await general(mundo, { tcOficial: null });
    const e = g.empresa!;
    expect(e.participacion_usd).toBeNull();
    expect(e.resultado_usd).toBeNull();
    expect(e.nota).toContain('XB-ANU sin utilidad cobrada');
  });

  it('T.C. oficial de varios días: memo por día y NUNCA más de 5 consultas a la vez', async () => {
    const { service } = armar(mundoEmpresa());
    let activas = 0;
    let maximo = 0;
    const pedidos: string[] = [];
    (
      service as unknown as {
        tipoCambio: { oficialDetallePara: (d: string) => Promise<unknown> };
      }
    ).tipoCambio.oficialDetallePara = async (dia: string) => {
      pedidos.push(dia);
      activas += 1;
      maximo = Math.max(maximo, activas);
      await new Promise((res) => setTimeout(res, 1));
      activas -= 1;
      return { tc: 20, fecha_dato: dia, fuente: 'OPEN_ER_API' };
    };
    const priv = service as unknown as {
      tcOficialDeDias: (
        dias: Iterable<string>,
        memo: Map<string, Promise<unknown>>,
      ) => Promise<Map<string, { tc: number }>>;
    };
    const dias = Array.from(
      { length: 12 },
      (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`,
    );
    const memo = new Map<string, Promise<unknown>>();
    const r = await priv.tcOficialDeDias([...dias, ...dias, 'basura'], memo);
    expect(r.size).toBe(12);
    expect(pedidos).toHaveLength(12); // cada día UNA vez; «basura» ni se pide
    expect(maximo).toBeLessThanOrEqual(5);
    // Un día ya en el memo no se vuelve a pedir.
    await priv.tcOficialDeDias(['2026-09-01'], memo);
    expect(pedidos).toHaveLength(12);
  });

  it('el T.C. por fila NO cambia el payload de «otros movimientos» (mismo que sin pedirlo)', async () => {
    const mundo = mundoEmpresa();
    const { g } = await general(mundo);
    const { service } = armar(mundo);
    const priv = service as unknown as {
      gastosEmpresaYSueltos: (d: string, h: string) => Promise<unknown>;
      buildOtrosMovimientos: (
        d: string,
        h: string,
        memo: Map<string, unknown>,
        e: unknown,
      ) => Promise<BalanceHojaOtrosMovimientosPayload>;
    };
    const solo = await priv.buildOtrosMovimientos(
      DESDE,
      HASTA,
      new Map(),
      await priv.gastosEmpresaYSueltos(DESDE, HASTA),
    );
    expect(JSON.stringify(g.consolidado.otros_movimientos)).toBe(
      JSON.stringify(solo),
    );
  });
});
