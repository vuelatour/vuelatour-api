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

import * as fs from 'fs';
import * as path from 'path';
import { AircraftBalanceService } from './aircraft-balance.service';
import { NOTA_PESOS_BALANCE_EMPRESA } from './balance-empresa.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceEmpresaBloquePayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  gastoBase,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';
import {
  AV2,
  TC_OFICIAL_PESOS,
  fakeSupabaseReparto,
  mundoPesos,
} from '../profit-sharing/reparto-pesos.fixture-spec';

/**
 * BALANCE POR AVIÓN Y GENERAL EN PESOS (18/19-oct-2026, API 0.0.94,
 * invariante 92). Pedido del cliente: «en los balances (balance general y
 * por avión) debe venir todo en pesos … y que los dólares solo sean
 * informativos». PESOS REALES: la MISMA cascada del bloque `balance` con lo
 * que el libro YA tiene en pesos —GANANCIA MXN de las filas, el TOTAL MXN de
 * cada hoja, el NETO MXN de «Otros ingresos» y el POR COBRAR MXN—; ningún
 * T.C. único. Todo es ADITIVO: sin las llaves nuevas, los libros salen BYTE
 * A BYTE como en el 0.0.93 (golden capturado con el código del 0.0.93 sobre
 * el MISMO mundo del reparto en pesos).
 */

const GOLDEN = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../profit-sharing/libros-pesos.golden-0093.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const r2 = (x: number) => Math.round(x * 100) / 100;

type General = {
  balance_en_pesos?: true;
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  empresa: BalanceEmpresaBloquePayload;
};

function servicio(
  m: Record<string, Fila[]>,
  mapa: Record<string, number> | null,
) {
  const f = fakeSupabaseReparto(m);
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
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
  return { service, enviados };
}

async function libro(
  m: Record<string, Fila[]> = mundoPesos(),
  avion: string = AV,
  mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
): Promise<BalanceAvionPayload> {
  const s = servicio(m, mapa);
  await s.service.xlsx(avion, DESDE, HASTA);
  return s.enviados.individual!;
}

async function general(
  m: Record<string, Fila[]> = mundoPesos(),
  mapa: Record<string, number> | null = TC_OFICIAL_PESOS,
): Promise<General> {
  const s = servicio(m, mapa);
  await s.service.xlsxGeneral(DESDE, HASTA);
  return s.enviados.general!;
}

/** El bloque `balance` sin la cascada en pesos (antes no tenía `*_mxn`). */
function limpiarBloque(b: Record<string, unknown> | undefined): void {
  if (!b) return;
  for (const k of Object.keys(b)) if (k.endsWith('_mxn')) delete b[k];
  for (const s of (b.socios as Array<Record<string, unknown>>) ?? []) {
    delete s.monto_mxn;
  }
}

/** Un libro de avión sin lo del 0.0.94 (y sin el sello de la fecha). */
function libroSinPesos(p: unknown): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  delete c.generado;
  delete c.balance_en_pesos;
  limpiarBloque(c.balance as Record<string, unknown>);
  return c;
}

/** El general sin lo del 0.0.94 (raíz, libros, consolidado y VUELATOUR). */
function generalSinPesos(g: unknown): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  delete c.generado;
  delete c.balance_en_pesos;
  c.aviones = (c.aviones as unknown[]).map(libroSinPesos);
  c.consolidado = libroSinPesos(c.consolidado);
  const e = c.empresa as Record<string, unknown>;
  for (const p of e.participaciones as Array<Record<string, unknown>>) {
    delete p.monto_mxn;
  }
  for (const k of [
    'participacion_mxn',
    'ingresos_propios_mxn',
    'pagos_vendedor_mxn',
    'otros_gastos_empresa_mxn',
    'tienda_utilidad_mxn',
    'resultado_mxn',
    'nota_pesos',
  ])
    delete e[k];
  return c;
}

const LLAVES_PESOS_BLOQUE = [
  'utilidad_antes_mxn',
  'combustible_mxn',
  'gastos_indirectos_mxn',
  'refacciones_mxn',
  'otros_mxn',
  'permisos_mxn',
  'otros_ingresos_avion_mxn',
  'utilidad_despues_mxn',
  'por_cobrar_mxn',
  'utilidad_cobrada_mxn',
  'comisiones_mxn',
  'utilidad_antes_comisiones_mxn',
];

describe('Balance EN PESOS (invariante 92) — los dólares de siempre', () => {
  it('GOLDEN: el libro individual sin lo del 0.0.94 es BYTE A BYTE el del 0.0.93', async () => {
    expect(JSON.stringify(libroSinPesos(await libro()))).toBe(
      JSON.stringify(GOLDEN.balance_individual),
    );
  });

  it('GOLDEN: el general sin lo del 0.0.94 es BYTE A BYTE el del 0.0.93', async () => {
    expect(JSON.stringify(generalSinPesos(await general()))).toBe(
      JSON.stringify(GOLDEN.balance_general),
    );
  });

  it('la bandera `balance_en_pesos` viaja en el libro individual, en la RAÍZ del general y en cada `aviones[]`; el consolidado FLOTA no la lleva', async () => {
    expect((await libro()).balance_en_pesos).toBe(true);
    const g = await general();
    expect(g.balance_en_pesos).toBe(true);
    expect(g.aviones.every((a) => a.balance_en_pesos === true)).toBe(true);
    expect('balance_en_pesos' in g.consolidado).toBe(false);
  });
});

describe('Balance EN PESOS — la cascada del bloque `balance`', () => {
  it('XB-TST: misma cascada con las celdas MXN del libro (GANANCIA, TOTAL de cada hoja, NETO de otros ingresos, POR COBRAR)', async () => {
    const p = await libro();
    const b = p.balance;
    expect(b.utilidad_antes_mxn).toBe(p.totales.ganancia_mxn);
    // GAS 3,000 MXN (hoja «combustible»), PERMISO 500 MXN, REFACCION 100
    // USD × el T.C. de las hojas (Gastos Indirectos) y ING-14 46,550.80.
    expect(b.combustible_mxn).toBe(3000);
    expect(b.combustible_mxn).toBe(r2(p.combustible!.total_mxn));
    expect(b.gastos_indirectos_mxn).toBe(r2(p.gastos_indirectos.total_mxn));
    expect(b.refacciones_mxn).toBe(r2(p.refacciones!.total_mxn));
    expect(b.otros_mxn).toBe(r2(p.otros_gastos.total_mxn));
    expect(b.permisos_mxn).toBe(500);
    expect(b.otros_ingresos_avion_mxn).toBe(46550.8);
    expect(b.utilidad_despues_mxn).toBe(
      r2(
        b.utilidad_antes_mxn! -
          b.combustible_mxn! -
          b.gastos_indirectos_mxn! -
          b.refacciones_mxn! -
          b.otros_mxn! -
          b.permisos_mxn! +
          b.otros_ingresos_avion_mxn!,
      ),
    );
    expect(b.por_cobrar_mxn).toBe(p.totales.por_cobrar_mxn);
    expect(b.utilidad_cobrada_mxn).toBe(
      r2(b.utilidad_despues_mxn! - b.por_cobrar_mxn!),
    );
    // Socios: % × la utilidad cobrada EN PESOS (lo que se transfiere).
    for (const s of b.socios) {
      expect(s.monto_mxn).toBe(
        r2((s.porcentaje / 100) * b.utilidad_cobrada_mxn!),
      );
    }
  });

  it('comisiones en pesos (solo con la regla): Σ COMISIONES MXN de las filas y la utilidad antes de ellas', async () => {
    const p = await libro();
    const b = p.balance;
    // #501: 350 × 2000/2230 = 313.90; #502: 30 USD × 18.25 = 547.50.
    expect(b.comisiones_mxn).toBe(861.4);
    expect(b.comisiones_mxn).toBe(
      r2(
        p.vuelos.reduce(
          (s, v) =>
            v.ganancia_mxn != null && v.comisiones_mxn != null
              ? s + v.comisiones_mxn
              : s,
          0,
        ),
      ),
    );
    expect(b.utilidad_antes_comisiones_mxn).toBe(
      r2(b.utilidad_antes_mxn! + 861.4),
    );
  });

  it('orden: las llaves en pesos van ANTES de las que los specs fijan como las últimas del bloque', async () => {
    const b = (await libro()).balance;
    const llaves = Object.keys(b);
    for (const k of LLAVES_PESOS_BLOQUE) expect(llaves).toContain(k);
    expect(llaves.slice(-3)).toEqual([
      'comisiones_usd',
      'utilidad_antes_comisiones_usd',
      'otros_ingresos_avion_usd',
    ]);
  });

  it('null se PROPAGA: una hoja con una fila sin pesos deja vacía la cascada en pesos y los socios (avión sin vuelos ni oficial del cierre)', async () => {
    const m = mundoPesos();
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
    expect(b.gastos_indirectos_mxn).toBeNull();
    expect(b.utilidad_despues_mxn).toBeNull();
    expect(b.utilidad_cobrada_mxn).toBeNull();
    expect(b.socios.every((s) => s.monto_mxn === null)).toBe(true);
  });
});

describe('Balance general EN PESOS — bloques de avión y VUELATOUR (empresa)', () => {
  it('el bloque de cada avión es el MISMO de su libro individual (también en pesos)', async () => {
    const g = await general();
    // El XB-DOS (sin vuelos ni gastos del avión) no entra al general.
    expect(g.aviones.map((a) => a.matricula)).toEqual(['XB-TST']);
    const ID: Record<string, string> = { 'XB-TST': AV, 'XB-DOS': AV2 };
    for (const bloque of g.aviones) {
      const ind = await libro(mundoPesos(), ID[bloque.matricula]);
      expect(bloque.balance).toEqual(ind.balance);
      expect(bloque.balance.utilidad_cobrada_mxn).not.toBeNull();
    }
  });

  it('VUELATOUR en pesos: participación (celda MXN de la socia), columnas MXN de «otros movimientos», «otros gastos» MXN, tienda vacía y su nota', async () => {
    const g = await general();
    const e = g.empresa;
    const socias = g.aviones.flatMap((a) =>
      a.balance.socios.filter((s) => s.es_empresa),
    );
    expect(e.participaciones.map((p) => p.monto_mxn)).toEqual(
      socias.map((s) => s.monto_mxn),
    );
    expect(e.participacion_mxn).toBe(
      r2(socias.reduce((s, x) => s + (x.monto_mxn ?? 0), 0)),
    );
    const om = g.consolidado.otros_movimientos!;
    const filas = [...om.filas, ...om.filas_sueltas];
    expect(e.ingresos_propios_mxn).toBe(
      r2(filas.reduce((s, f) => s + (f.ingreso_mxn ?? 0), 0)),
    );
    expect(e.pagos_vendedor_mxn).toBe(
      r2(filas.reduce((s, f) => s + (f.egreso_mxn ?? 0), 0)),
    );
    expect(e.otros_gastos_empresa_mxn).toBe(
      r2(
        (g as unknown as { gastos_empresa: { total_mxn: number } })
          .gastos_empresa.total_mxn,
      ),
    );
    // Sin inventario en el periodo: celda vacía (no anula el resultado).
    expect(e.tienda_utilidad_mxn).toBeNull();
    expect(e.resultado_mxn).toBe(
      r2(
        e.participacion_mxn! +
          e.ingresos_propios_mxn! -
          e.pagos_vendedor_mxn! -
          e.otros_gastos_empresa_mxn!,
      ),
    );
    expect(e.nota_pesos).toBe(NOTA_PESOS_BALANCE_EMPRESA);
  });
});
