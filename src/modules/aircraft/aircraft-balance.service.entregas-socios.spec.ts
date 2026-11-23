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
  fuenteTcLegible: (f: string | null | undefined) =>
    f === 'OPEN_ER_API' ? 'open.er-api' : (f ?? 'TC oficial'),
}));
// Sin la migración del cierre de mes (el eje de siempre).
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

import {
  AircraftBalanceService,
  entregasPorSocioDelAvion,
  entregasQueCuentanEnAvion,
  vuelosUtilidadesDelAvion,
} from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceEmpresaBloquePayload,
} from '../pyservices/pyservices.service';
import type { RepartoPagoRow } from '../profit-sharing/reparto-pago.util';
import {
  AV,
  DESDE,
  HASTA,
  gastoBase,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';
import {
  ACC,
  AV2,
  HERNAN,
  MAU,
  TC_OFICIAL_PESOS,
  fakeSupabaseReparto,
  mundoPesos,
} from '../profit-sharing/reparto-pesos.fixture-spec';

/**
 * ENTREGAS A SOCIOS EN EL BALANCE (21-oct-2026, invariante 100). Pedido del
 * cliente: «debemos agregar en el balance general y por avión los pagos que
 * se vayan dando a los socios». En `balance.socios[]` de cada libro de avión
 * (individual y cada bloque del general), ADITIVO: lo YA entregado a cada
 * socio «por este avión» en los meses del periodo —la MISMA regla de la
 * pantalla por avión del reparto: entregas VIVAS de `reparto_pago` con
 * `aeronave_id` = el avión y mes acreditado (`periodo` ?? mes de
 * `fecha_pago`) dentro del periodo— EN PESOS (`entregado_mxn`), el USD
 * informativo, el conteo y lo POR ENTREGAR (= `monto_mxn` − entregado). Por
 * avión, las Σ. Sin la cuenta corriente (migración `20261020000006`) nada
 * viaja: jamás un 0 inventado.
 */

const r2 = (x: number) => Math.round(x * 100) / 100;

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  empresa: BalanceEmpresaBloquePayload;
};

function servicio(
  m: Record<string, Fila[]>,
  mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
  opts: { sinMigracionCuenta?: boolean } = {},
) {
  const f = fakeSupabaseReparto(m);
  const fromBase = f.supabase.service.from;
  // Sin la migración de la cuenta corriente: `reparto_pago` no existe y la
  // sonda del lector recibe el 42P01 de PostgREST ⇒ cuenta «no disponible».
  const from = (tabla: string) => {
    if (!opts.sinMigracionCuenta || tabla !== 'reparto_pago') {
      return fromBase(tabla);
    }
    const error = {
      code: '42P01',
      message: 'relation "public.reparto_pago" does not exist',
    };
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'is', 'eq', 'gte', 'lte', 'order', 'range'])
      q[k] = () => q;
    q.limit = () => q;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error }).then(res, rej);
    return q;
  };
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const service = new AircraftBalanceService(
    { service: { from } } as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        enviados.individual = p;
        return Promise.resolve(Buffer.from('x'));
      },
      generateBalanceGeneralXlsx: (p: General) => {
        enviados.general = p;
        return Promise.resolve(Buffer.from('x'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    {
      oficialDetallePara: (dia: string) => {
        const tc = mapa?.[dia];
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  return { service, enviados, tablasLeidas: f.tablasLeidas };
}

async function libro(
  m: Record<string, Fila[]>,
  avion: string = AV,
  mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
): Promise<BalanceAvionPayload> {
  const s = servicio(m, mapa);
  await s.service.xlsx(avion, DESDE, HASTA);
  return s.enviados.individual!;
}

async function general(m: Record<string, Fila[]>): Promise<General> {
  const s = servicio(m);
  await s.service.xlsxGeneral(DESDE, HASTA);
  return s.enviados.general!;
}

function entrega(extra: Fila): Fila {
  return {
    id: 'p-x',
    aeronave_id: AV,
    socio_id: HERNAN,
    periodo: null,
    monto: 0,
    moneda: 'MXN',
    tc_usd_mxn: null,
    monto_usd: 0,
    monto_mxn: 0,
    utilidad_snapshot_usd: null,
    saldo_snapshot_usd: null,
    saldo_snapshot_mxn: null,
    fecha_pago: '2026-10-05',
    metodo: 'TRANSFERENCIA',
    referencia: null,
    entregado_por: ACC,
    recibido_por: null,
    factura_folio: null,
    comprobante_path: null,
    notas: null,
    client_request_id: null,
    created_by: ACC,
    created_at: '2026-10-05T15:00:00Z',
    updated_by: null,
    updated_at: '2026-10-05T15:00:00Z',
    deleted_at: null,
    deleted_by: null,
    motivo_baja: null,
    ...extra,
  };
}

/** Las entregas del mundo: solo dos cuentan en el XB-TST de septiembre. */
const ENTREGAS: Fila[] = [
  // «Corresponde a» septiembre, pagada en octubre, en pesos: cuenta (1,000
  // MXN; 54.05 USD informativos al T.C. de la entrega).
  entrega({
    id: 'p-sep-mxn',
    periodo: '2026-09-01',
    monto: 1000,
    monto_mxn: 1000,
    tc_usd_mxn: 18.5,
    monto_usd: 54.05,
    fecha_pago: '2026-10-05',
  }),
  // Sin «corresponde a», pagada el 20-sep en dólares: se acredita a
  // septiembre por su fecha y descuenta sus pesos (100 × 18.50 = 1,850).
  entrega({
    id: 'p-sep-usd',
    moneda: 'USD',
    monto: 100,
    monto_usd: 100,
    monto_mxn: 1850,
    fecha_pago: '2026-09-20',
    created_at: '2026-09-20T15:00:00Z',
  }),
  // Borrada: no cuenta.
  entrega({
    id: 'p-borrada',
    periodo: '2026-09-01',
    monto: 500,
    monto_mxn: 500,
    deleted_at: '2026-10-06T15:00:00Z',
    deleted_by: ACC,
  }),
  // De OTRO avión (XB-DOS, de Mauricio): no cuenta en el XB-TST; sí en el
  // XB-DOS.
  entrega({
    id: 'p-otro-avion',
    aeronave_id: AV2,
    socio_id: MAU,
    periodo: '2026-09-01',
    monto: 999,
    monto_mxn: 999,
    tc_usd_mxn: 18.5,
    monto_usd: 54,
  }),
  // «Corresponde a» agosto aunque se pagó el 2-sep: fuera del periodo.
  entrega({
    id: 'p-ago',
    periodo: '2026-08-01',
    monto: 700,
    monto_mxn: 700,
    fecha_pago: '2026-09-02',
    created_at: '2026-09-02T15:00:00Z',
  }),
  // Sin «corresponde a» y pagada el 3-oct: se acredita a octubre, fuera.
  entrega({
    id: 'p-oct',
    monto: 300,
    monto_mxn: 300,
    fecha_pago: '2026-10-03',
  }),
  // Sin avión (adelanto a cuenta): no corresponde a ningún libro.
  entrega({
    id: 'p-sin-avion',
    aeronave_id: null,
    periodo: '2026-09-01',
    monto: 250,
    monto_mxn: 250,
  }),
];

function mundoConEntregas(extra: Fila[] = []): Record<string, Fila[]> {
  return { ...mundoPesos(), reparto_pago: [...ENTREGAS, ...extra] };
}

const LLAVES_SOCIO = [
  'entregado_mxn',
  'entregado_usd',
  'entregas',
  'por_entregar_mxn',
] as const;

/** El bloque sin lo de las entregas (lo que viaja sin la cuenta corriente). */
function sinEntregas(
  b: BalanceAvionPayload['balance'],
): BalanceAvionPayload['balance'] {
  const c = JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
  delete c.entregado_socios_mxn;
  delete c.por_entregar_socios_mxn;
  for (const s of c.socios as Array<Record<string, unknown>>)
    for (const k of LLAVES_SOCIO) delete s[k];
  return c as unknown as BalanceAvionPayload['balance'];
}

describe('entregasPorSocioDelAvion (puro): qué entregas cuentan', () => {
  it('vivas, de ESE avión y acreditadas a un mes del periodo (periodo ?? mes de la fecha de pago); Σ pesos / USD / conteo por socio', () => {
    const filas = ENTREGAS as unknown as RepartoPagoRow[];
    expect([...entregasPorSocioDelAvion(filas, AV, DESDE, HASTA)]).toEqual([
      [HERNAN, { mxn: 2850, usd: 154.05, n: 2 }],
    ]);
    // Un periodo agosto–septiembre SÍ acredita la de agosto (pagada en
    // septiembre, «corresponde a» agosto).
    expect(
      entregasPorSocioDelAvion(filas, AV, '2026-08-01', HASTA).get(HERNAN),
    ).toEqual({ mxn: 3550, usd: 154.05, n: 3 });
    // El XB-DOS solo ve la de Mauricio.
    expect([...entregasPorSocioDelAvion(filas, AV2, DESDE, HASTA)]).toEqual([
      [MAU, { mxn: 999, usd: 54, n: 1 }],
    ]);
    // Octubre: solo la pagada el 3-oct sin «corresponde a».
    expect(
      entregasPorSocioDelAvion(filas, AV, '2026-10-01', '2026-10-31').get(
        HERNAN,
      ),
    ).toEqual({ mxn: 300, usd: 0, n: 1 });
  });
});

describe('Balance por avión — ENTREGAS A SOCIOS (invariante 100)', () => {
  it('por socio: entregado «por este avión» en los meses del periodo (pesos, USD informativo, conteo) y por entregar = monto MXN − entregado; por avión, las Σ', async () => {
    const b = (await libro(mundoConEntregas())).balance;
    expect(b.socios.map((s) => s.nombre)).toEqual([
      'Aero Charter Cancun S.A. de C.V.',
      'Hernán Pérez',
    ]);
    const [acc, hernan] = b.socios;
    // 1,000 (sep, MXN) + 1,850 (USD 100 del 20-sep) = 2,850; la borrada, la
    // de otro avión, la de agosto, la de octubre y la sin avión NO.
    expect(hernan).toMatchObject({
      entregado_mxn: 2850,
      entregado_usd: 154.05,
      entregas: 2,
    });
    expect(hernan.monto_mxn).not.toBeNull();
    expect(hernan.por_entregar_mxn).toBe(r2(hernan.monto_mxn! - 2850));
    expect(acc).toMatchObject({
      entregado_mxn: 0,
      entregado_usd: 0,
      entregas: 0,
      por_entregar_mxn: acc.monto_mxn,
    });
    expect(b.entregado_socios_mxn).toBe(2850);
    expect(b.por_entregar_socios_mxn).toBe(
      r2(hernan.por_entregar_mxn! + acc.por_entregar_mxn!),
    );
    // Lo de siempre no se mueve: el bloque sin las llaves nuevas es el del
    // mundo sin ninguna entrega.
    expect(sinEntregas(b)).toEqual(
      sinEntregas((await libro(mundoPesos())).balance),
    );
  });

  it('XB-DOS: Mauricio recibió 999 «por su avión» (el XB-TST no lo ve); sin utilidad, por entregar es −999 (se le adelantó)', async () => {
    const b = (await libro(mundoConEntregas(), AV2)).balance;
    expect(
      b.socios.map((s) => [
        s.nombre,
        s.monto_mxn,
        s.entregado_mxn,
        s.entregas,
        s.por_entregar_mxn,
      ]),
    ).toEqual([['Mauricio Roque', 0, 999, 1, -999]]);
    expect(b.entregado_socios_mxn).toBe(999);
    expect(b.por_entregar_socios_mxn).toBe(-999);
  });

  it('sin entregas en el periodo las llaves viajan en 0 y por entregar = el monto en pesos de cada socio', async () => {
    const b = (await libro(mundoPesos())).balance;
    expect(b.entregado_socios_mxn).toBe(0);
    for (const s of b.socios) {
      expect(s).toMatchObject({
        entregado_mxn: 0,
        entregado_usd: 0,
        entregas: 0,
        por_entregar_mxn: s.monto_mxn,
      });
    }
    expect(b.por_entregar_socios_mxn).toBe(
      r2(b.socios.reduce((a, s) => a + s.monto_mxn!, 0)),
    );
  });

  it('un socio que YA NO está en aeronave_socio pero recibió entregas por el avión entra al final como renglón con porcentaje 0 y montos 0 (nombre por `usuario`; desconocido ⇒ «Socio»); la VUELATOUR no cambia', async () => {
    const m = mundoConEntregas([
      entrega({
        id: 'p-ex-socio',
        socio_id: MAU,
        periodo: '2026-09-01',
        monto: 500,
        monto_mxn: 500,
        tc_usd_mxn: 18.5,
        monto_usd: 27.03,
      }),
      entrega({
        id: 'p-desconocido',
        socio_id: 'u-nadie',
        periodo: '2026-09-01',
        monto: 10,
        monto_mxn: 10,
      }),
    ]);
    const b = (await libro(m)).balance;
    expect(b.socios.map((s) => s.nombre)).toEqual([
      'Aero Charter Cancun S.A. de C.V.',
      'Hernán Pérez',
      'Mauricio Roque',
      'Socio',
    ]);
    expect(b.socios[2]).toEqual({
      nombre: 'Mauricio Roque',
      porcentaje: 0,
      monto_usd: 0,
      es_empresa: false,
      monto_mxn: 0,
      descuenta_reserva: false,
      utilidad_usd: 0,
      utilidad_mxn: 0,
      reserva_usd: 0,
      reserva_mxn: 0,
      entregado_mxn: 500,
      entregado_usd: 27.03,
      entregas: 1,
      por_entregar_mxn: -500,
    });
    expect(b.socios[3]).toMatchObject({
      nombre: 'Socio',
      porcentaje: 0,
      entregado_mxn: 10,
      por_entregar_mxn: -10,
    });
    expect(b.entregado_socios_mxn).toBe(3360);
    expect(b.por_entregar_socios_mxn).toBe(
      r2(b.socios.reduce((a, s) => a + s.por_entregar_mxn!, 0)),
    );
    // Solo la socia vigente participa en el bloque VUELATOUR.
    const g = await general(m);
    expect(
      g.empresa.participaciones.map((p) => [p.socio, p.porcentaje]),
    ).toEqual([['Aero Charter Cancun S.A. de C.V.', 59.08]]);
  });

  it('dos vigencias del mismo socio en el periodo: sus entregas van en el primer renglón (mayor %) y el otro queda en 0 — nunca se cuentan dos veces', async () => {
    const m = mundoConEntregas();
    m.aeronave_socio = [
      ...m.aeronave_socio,
      {
        aeronave_id: AV,
        socio_id: HERNAN,
        porcentaje: '10.000',
        vigente_desde: '2026-09-15',
        vigente_hasta: null,
        usuario: { nombre: 'Hernán Pérez', es_empresa: false },
      },
    ];
    const b = (await libro(m)).balance;
    expect(
      b.socios
        .filter((s) => s.nombre === 'Hernán Pérez')
        .map((s) => [s.porcentaje, s.entregado_mxn, s.entregas]),
    ).toEqual([
      [40.92, 2850, 2],
      [10, 0, 0],
    ]);
    expect(b.entregado_socios_mxn).toBe(2850);
  });

  it('null se PROPAGA: sin pesos en la cascada, por entregar es null (por socio y en el avión); lo entregado sigue', async () => {
    const m = mundoConEntregas();
    m.gasto = [
      ...m.gasto,
      {
        ...gastoBase,
        id: 'g-dos-usd',
        aeronave_id: AV2,
        categoria: 'REFACCION',
        moneda: 'USD',
        monto: 50,
      },
    ];
    const b = (await libro(m, AV2, null)).balance;
    expect(b.utilidad_cobrada_mxn).toBeNull();
    expect(b.socios[0]).toMatchObject({
      nombre: 'Mauricio Roque',
      monto_mxn: null,
      entregado_mxn: 999,
      por_entregar_mxn: null,
    });
    expect(b.entregado_socios_mxn).toBe(999);
    expect(b.por_entregar_socios_mxn).toBeNull();
  });

  it('sin la migración de la cuenta corriente (`reparto_pago` no existe): las llaves NO viajan —ni un 0 inventado— y el bloque es el de siempre', async () => {
    const s = servicio(mundoConEntregas(), TC_OFICIAL_PESOS, {
      sinMigracionCuenta: true,
    });
    await s.service.xlsx(AV, DESDE, HASTA);
    const b = s.enviados.individual!.balance;
    expect('entregado_socios_mxn' in b).toBe(false);
    expect('por_entregar_socios_mxn' in b).toBe(false);
    for (const x of b.socios)
      for (const k of LLAVES_SOCIO) expect(k in x).toBe(false);
    expect(b).toEqual(sinEntregas((await libro(mundoConEntregas())).balance));
    const g = servicio(mundoConEntregas(), TC_OFICIAL_PESOS, {
      sinMigracionCuenta: true,
    });
    await g.service.xlsxGeneral(DESDE, HASTA);
    for (const a of g.enviados.general!.aviones) {
      expect('entregado_socios_mxn' in a.balance).toBe(false);
      for (const x of a.balance.socios)
        for (const k of LLAVES_SOCIO) expect(k in x).toBe(false);
    }
  });

  it('orden de llaves: por socio las cuatro van al FINAL (tras la reserva); en el bloque, justo después de la reserva y antes de las tres últimas de siempre', async () => {
    const b = (await libro(mundoConEntregas())).balance;
    for (const s of b.socios)
      expect(Object.keys(s).slice(-4)).toEqual([...LLAVES_SOCIO]);
    const keys = Object.keys(b);
    // LA RESERVA RESTA EN LA CASCADA (9-nov-2026, invariante 125): el grupo
    // de la reserva cierra con `reserva_overhaul_en_cascada`; las entregas
    // van justo después.
    const r = keys.indexOf('reserva_overhaul_incompleta');
    expect(r).toBeGreaterThan(0);
    expect(keys[r + 1]).toBe('reserva_overhaul_en_cascada');
    const i = r + 1;
    expect(keys.slice(i + 1, i + 3)).toEqual([
      'entregado_socios_mxn',
      'por_entregar_socios_mxn',
    ]);
    expect(keys.slice(-3)).toEqual([
      'comisiones_usd',
      'utilidad_antes_comisiones_usd',
      'otros_ingresos_avion_usd',
    ]);
  });
});

describe('Balance general — ENTREGAS A SOCIOS en cada bloque de avión', () => {
  it('el bloque de cada avión trae las MISMAS entregas que su libro individual, con UNA sola lectura de reparto_pago (más la sonda) para todo el general; el consolidado FLOTA y EXTERNOS no reparten', async () => {
    const s = servicio(mundoConEntregas());
    await s.service.xlsxGeneral(DESDE, HASTA);
    const g = s.enviados.general!;
    expect(g.aviones.map((a) => a.matricula)).toEqual(['XB-TST']);
    const tst = g.aviones[0];
    expect(tst.balance).toEqual((await libro(mundoConEntregas())).balance);
    expect(tst.balance.entregado_socios_mxn).toBe(2850);
    expect(s.tablasLeidas.filter((t) => t === 'reparto_pago')).toHaveLength(2);
    expect('entregado_socios_mxn' in g.consolidado.balance).toBe(false);
    expect(g.consolidado.balance.socios).toEqual([]);
  });
});

// ===========================================================================
// VUELOS PAGADOS CON UTILIDADES DEL SOCIO (23-nov-2026, API 0.0.148,
// invariante 143). Un vuelo pagado con utilidades es una ENTREGA más
// (`reparto_pago`, método OTRO) que un cobro de vuelo cita por
// `cobro_vuelo.reparto_pago_id`. El balance la sigue contando en
// `entregado_mxn` / `por_entregar_mxn` como siempre y, ADEMÁS, dice cuánto de
// lo entregado fue un vuelo y cuánto dinero de verdad, con el detalle.
// ===========================================================================

/** Hernán paga con utilidades de septiembre un vuelo de $500 (el #777). */
const ENTREGA_DE_VUELO = entrega({
  id: 'p-vuelo',
  periodo: '2026-09-01',
  monto: 500,
  monto_mxn: 500,
  tc_usd_mxn: 18.5,
  monto_usd: 27.03,
  metodo: 'OTRO',
  referencia: 'Vuelo #777',
  fecha_pago: '2026-09-18',
  created_at: '2026-09-18T15:00:00Z',
});

/**
 * El cobro que cita la entrega. Es de un vuelo que NO está en el libro del
 * periodo (un vuelo de octubre pagado con utilidades de septiembre, o en
 * otro avión): así el dinero del libro no se mueve y lo único que cambia son
 * las llaves nuevas.
 */
const COBRO_QUE_LA_CITA: Fila = {
  id: 'c-777',
  vuelo_id: 'v-fuera-del-libro',
  monto: 500,
  moneda: 'MXN',
  tc_usd_mxn: 18.5,
  metodo_cobro: 'OTRO',
  fecha_cobro: '2026-09-18T17:00:00+00:00',
  reparto_pago_id: 'p-vuelo',
  vuelo: {
    folio: 777,
    fecha_vuelo: '2026-10-02T15:00:00+00:00',
    cliente: { nombre: 'Hernán en su avión' },
    aeronave: { matricula: 'XB-DOS' },
  },
};

function mundoConVuelo(conCobro = true): Record<string, Fila[]> {
  const m = mundoConEntregas([ENTREGA_DE_VUELO]);
  return conCobro
    ? { ...m, cobro_vuelo: [...(m.cobro_vuelo ?? []), COBRO_QUE_LA_CITA] }
    : m;
}

const LLAVES_VUELOS_SOCIO = [
  'vuelos_utilidades_mxn',
  'entregado_efectivo_mxn',
  'entregado_efectivo_usd',
] as const;
const LLAVES_VUELOS_AVION = [
  'vuelos_utilidades_socios_mxn',
  'entregado_efectivo_socios_mxn',
  'vuelos_utilidades',
] as const;

/** El bloque sin las llaves nuevas (lo que viajaba hasta el 0.0.147). */
function sinVuelosUtilidades(
  b: BalanceAvionPayload['balance'],
): BalanceAvionPayload['balance'] {
  const c = JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
  for (const k of LLAVES_VUELOS_AVION) delete c[k];
  for (const s of c.socios as Array<Record<string, unknown>>) {
    for (const k of LLAVES_VUELOS_SOCIO) delete s[k];
  }
  return c as unknown as BalanceAvionPayload['balance'];
}

describe('vuelosUtilidadesDelAvion (puro): de lo entregado, lo que fue un vuelo', () => {
  const filas = [...ENTREGAS, ENTREGA_DE_VUELO] as unknown as RepartoPagoRow[];
  const vuelos = new Map([
    [
      'p-vuelo',
      {
        id: 'v-fuera-del-libro',
        folio: 777,
        cobro_id: 'c-777',
        fecha: '2026-10-02',
        cliente: 'Hernán en su avión',
        matricula: 'XB-DOS',
      },
    ],
  ]);

  it('es un SUBCONJUNTO de las entregas que cuentan (mismo filtro): por socio y con su detalle', () => {
    const cuentan = entregasQueCuentanEnAvion(filas, AV, DESDE, HASTA);
    expect(cuentan.map((r) => r.id).sort()).toEqual([
      'p-sep-mxn',
      'p-sep-usd',
      'p-vuelo',
    ]);
    const r = vuelosUtilidadesDelAvion(filas, AV, DESDE, HASTA, vuelos);
    expect([...r.porSocio]).toEqual([[HERNAN, { mxn: 500, usd: 27.03, n: 1 }]]);
    expect(r.detalle).toEqual([
      {
        socio_id: HERNAN,
        folio: 777,
        fecha: '2026-10-02',
        matricula: 'XB-DOS',
        cliente: 'Hernán en su avión',
        monto_mxn: 500,
      },
    ]);
    // Lo entregado sigue contando el vuelo (nada se resta dos veces).
    expect(
      entregasPorSocioDelAvion(filas, AV, DESDE, HASTA).get(HERNAN),
    ).toEqual({
      mxn: 3350,
      usd: 181.08,
      n: 3,
    });
  });

  it('sin cobros que citen entregas, o en otro avión o periodo: vacío', () => {
    expect(
      vuelosUtilidadesDelAvion(filas, AV, DESDE, HASTA, new Map()).detalle,
    ).toEqual([]);
    expect(
      vuelosUtilidadesDelAvion(filas, AV2, DESDE, HASTA, vuelos).detalle,
    ).toEqual([]);
    expect(
      vuelosUtilidadesDelAvion(filas, AV, '2026-10-01', '2026-10-31', vuelos)
        .detalle,
    ).toEqual([]);
  });
});

describe('Balance por avión — VUELOS PAGADOS CON UTILIDADES (invariante 143)', () => {
  it('ADITIVO: el libro es el MISMO que con la entrega sin ligar; solo ganan las llaves nuevas (por socio y por avión)', async () => {
    const con = await libro(mundoConVuelo());
    const sin = await libro(mundoConVuelo(false));
    // Sin cobro que la cite, la entrega es una entrega normal: ni una llave nueva.
    expect(JSON.stringify(sin)).not.toContain('vuelos_utilidades');
    expect(JSON.stringify(sin)).not.toContain('entregado_efectivo');
    // Con el cobro: todo lo demás idéntico (dinero, cascada, entregado, por entregar).
    expect(sinVuelosUtilidades(con.balance)).toEqual(sin.balance);
    expect({ ...con, balance: null }).toEqual({ ...sin, balance: null });
  });

  it('por socio: cuánto fue vuelo y cuánto dinero; `entregado_mxn` y `por_entregar_mxn` siguen netos de todo', async () => {
    const { balance } = await libro(mundoConVuelo());
    const conVuelo = balance.socios.filter(
      (s) => (s.vuelos_utilidades_mxn ?? 0) > 0,
    );
    expect(conVuelo).toHaveLength(1);
    const hernan = conVuelo[0];
    expect(hernan).toMatchObject({
      entregado_mxn: 3350,
      entregas: 3,
      vuelos_utilidades_mxn: 500,
      entregado_efectivo_mxn: 2850,
      entregado_efectivo_usd: 154.05,
    });
    expect(hernan.por_entregar_mxn).toBe(r2(hernan.monto_mxn! - 3350));
    // Los demás socios: las llaves viajan en 0 (el bloque tiene la columna).
    for (const s of balance.socios.filter((x) => x !== hernan)) {
      expect(s.vuelos_utilidades_mxn).toBe(0);
      expect(s.entregado_efectivo_mxn).toBe(s.entregado_mxn);
    }
    // Las llaves nuevas van al FINAL del socio.
    expect(Object.keys(hernan).slice(-3)).toEqual([...LLAVES_VUELOS_SOCIO]);
  });

  it('por avión: el discriminador (Σ), lo entregado en dinero y el detalle del vuelo con el nombre del socio', async () => {
    const { balance } = await libro(mundoConVuelo());
    expect(balance.entregado_socios_mxn).toBe(3350);
    expect(balance.vuelos_utilidades_socios_mxn).toBe(500);
    expect(balance.entregado_efectivo_socios_mxn).toBe(2850);
    const hernan = balance.socios.find(
      (s) => (s.vuelos_utilidades_mxn ?? 0) > 0,
    )!;
    expect(balance.vuelos_utilidades).toEqual([
      {
        folio: 777,
        fecha: '2026-10-02',
        socio: hernan.nombre,
        // El avión que VOLÓ puede no ser el de las utilidades.
        matricula: 'XB-DOS',
        cliente: 'Hernán en su avión',
        monto_mxn: 500,
      },
    ]);
    // Justo después de las dos de entregas, en ese orden.
    const keys = Object.keys(balance);
    const i = keys.indexOf('por_entregar_socios_mxn');
    expect(keys.slice(i + 1, i + 4)).toEqual([...LLAVES_VUELOS_AVION]);
  });

  it('sin entregas `OTRO` en el periodo no se pregunta nada a `cobro_vuelo` por ligas (cero consultas extra)', async () => {
    const s = servicio(mundoConEntregas());
    await s.service.xlsx(AV, DESDE, HASTA);
    const base = s.tablasLeidas.filter((t) => t === 'cobro_vuelo').length;
    const conOtro = servicio(mundoConVuelo());
    await conOtro.service.xlsx(AV, DESDE, HASTA);
    // Con la entrega OTRO: la sonda de la columna + la lectura de la liga.
    expect(conOtro.tablasLeidas.filter((t) => t === 'cobro_vuelo').length).toBe(
      base + 2,
    );
  });

  it('un socio que ya no está vigente pero pagó un vuelo con utilidades: su renglón también trae el desglose', async () => {
    const m = mundoConVuelo();
    m.reparto_pago = m.reparto_pago.map((p) =>
      p.id === 'p-vuelo' ? { ...p, socio_id: 'u-fantasma' } : p,
    );
    const { balance } = await libro(m);
    const fuera = balance.socios.at(-1)!;
    expect(fuera).toMatchObject({
      nombre: 'Socio',
      porcentaje: 0,
      entregado_mxn: 500,
      vuelos_utilidades_mxn: 500,
      entregado_efectivo_mxn: 0,
      por_entregar_mxn: -500,
    });
    expect(balance.vuelos_utilidades?.[0]).toMatchObject({ socio: 'Socio' });
  });

  it('«cómo se cobró»: un cobro del libro pagado con utilidades dice «Utilidades del socio (Nombre)», no «Otro»', async () => {
    const m = mundoConEntregas();
    const cobros = m.cobro_vuelo ?? [];
    expect(cobros.length).toBeGreaterThan(0);
    const [primero, ...resto] = cobros;
    const con = await libro({
      ...m,
      cobro_vuelo: [
        {
          ...primero,
          metodo_cobro: 'OTRO',
          cuenta_destino: null,
          reparto_pago_id: 'p-sep-mxn',
          entrega: { socio: { nombre: 'Hernán Garza' } },
        },
        ...resto,
      ],
    });
    const texto = JSON.stringify(con.vuelos);
    expect(texto).toContain('Utilidades del socio (Hernán Garza)');
    expect(texto).not.toContain('"metodo_etiqueta":"Otro"');
    // El MISMO cobro como «Otro» normal (sin liga): la etiqueta de siempre.
    const sin = await libro({
      ...m,
      cobro_vuelo: [
        { ...primero, metodo_cobro: 'OTRO', cuenta_destino: null },
        ...resto,
      ],
    });
    expect(JSON.stringify(sin.vuelos)).toContain('"metodo_etiqueta":"Otro"');
    expect(JSON.stringify(sin.vuelos)).not.toContain('Utilidades del socio');
  });
});

describe('Balance general — VUELOS PAGADOS CON UTILIDADES en el bloque de su avión', () => {
  it('el bloque del avión trae el mismo desglose que su libro individual; el consolidado FLOTA no', async () => {
    const g = await general(mundoConVuelo());
    const tst = g.aviones.find((a) => a.matricula === 'XB-TST')!;
    expect(tst.balance).toEqual((await libro(mundoConVuelo())).balance);
    expect(tst.balance.vuelos_utilidades_socios_mxn).toBe(500);
    expect(tst.balance.vuelos_utilidades).toHaveLength(1);
    expect('vuelos_utilidades_socios_mxn' in g.consolidado.balance).toBe(false);
  });
});
