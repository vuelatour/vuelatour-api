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
    const i = keys.indexOf('reserva_overhaul_incompleta');
    expect(i).toBeGreaterThan(0);
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
