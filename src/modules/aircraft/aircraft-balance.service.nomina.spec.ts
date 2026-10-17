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
// CIERRE DE MES (invariante 89): conducta SIN la migración (como los demás
// specs de los libros que no son `*.cierre-mes.spec.ts`).
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionGastoFilaPayload,
  BalanceAvionPayload,
  BalanceEmpresaBloquePayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  fakeSupabase,
  gastoBase,
  mundoLibros,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * NÓMINA FUERA DE «OTROS GASTOS» SIN REPARTO (16-oct-2026, API 0.0.90,
 * invariante 91). Pedido del cliente: la nómina «ya solo así repartido y
 * asignado se vaya al balance del avión y al general». Hasta el 0.0.89 una
 * NÓMINA sin reparto iba a la hoja «otros gastos» del Balance general (por
 * ser categoría de EMPRESA). Ahora:
 *  - SIN reparto: no entra a ningún libro; aviso «Nómina sin repartir: …» en
 *    `consolidado.pendientes`;
 *  - REPARTIDA: igual que siempre (parciales a «Gastos Indirectos» de cada
 *    avión; remanente de un parcial a «otros gastos»);
 *  - los demás gastos de empresa: byte a byte.
 */
const CONFIG_VIGENCIA_POSTERIOR = {
  fecha: () => Promise.resolve('2026-12-01'),
};

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  gastos_empresa: {
    filas: BalanceAvionGastoFilaPayload[];
    total_mxn: number;
    usd: number | null;
  };
  empresa?: BalanceEmpresaBloquePayload;
};

const nomina = (id: string, extra: Fila = {}): Fila => ({
  ...gastoBase,
  id,
  categoria: 'NOMINA',
  monto: 2000,
  notas: `Nómina ${id}`,
  ...extra,
});

/** Sin reparto: una en pesos sellada a un avión y una en dólares. */
const SIN_REPARTO: Fila[] = [
  nomina('g-nom-1', { aeronave_id: AV }),
  nomina('g-nom-usd', { monto: 100, moneda: 'USD', tc_gasto: 20 }),
];
/** Repartida COMPLETA al avión y una PARCIAL (remanente 300). */
const REPARTIDAS: Fila[] = [
  nomina('g-nom-rep', { monto: 1000 }),
  nomina('g-nom-parcial', { monto: 900 }),
];

function mundo(gastos: Fila[]): Record<string, Fila[]> {
  const m = mundoLibros();
  const todos = [...m.gasto, ...gastos];
  const parte = (gastoId: string, monto: number): Fila => ({
    gasto_id: gastoId,
    aeronave_id: AV,
    monto,
    gasto: todos.find((g) => g.id === gastoId),
  });
  return {
    ...m,
    gasto: todos,
    gasto_reparto: gastos.some((g) => g.id === 'g-nom-rep')
      ? [parte('g-nom-rep', 1000), parte('g-nom-parcial', 600)]
      : [],
  };
}

async function libros(gastos: Fila[]) {
  const f = fakeSupabase(mundo(gastos));
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
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
        Promise.resolve({ tc: 25, fecha_dato: dia, fuente: 'OPEN_ER_API' }),
    } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
    CONFIG_VIGENCIA_POSTERIOR as never,
  );
  await service.xlsxGeneral(DESDE, HASTA);
  await service.xlsx(AV, DESDE, HASTA);
  return { general: enviados.general!, avion: enviados.individual! };
}

/** Sin las llaves `generado` (sello de hora de cada armado). */
function sinSello(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sinSello);
  if (x && typeof x === 'object') {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>)
        .filter(([k]) => k !== 'generado')
        .map(([k, v]) => [k, sinSello(v)]),
    );
  }
  return x;
}

const detalles = (filas: BalanceAvionGastoFilaPayload[]) =>
  filas.map((f) => f.detalle ?? '').join(' | ');

describe('Balance — NÓMINA sin reparto fuera de «otros gastos» (invariante 91)', () => {
  it('SIN reparto: no está en «otros gastos» del general ni en el libro del avión, y sale el aviso del consolidado', async () => {
    const { general, avion } = await libros(SIN_REPARTO);
    expect(detalles(general.gastos_empresa.filas)).not.toContain('Nómina');
    // Solo el OTRO de 700 de siempre.
    expect(general.gastos_empresa.total_mxn).toBe(700);
    expect(detalles(avion.gastos_indirectos.filas)).not.toContain('Nómina');
    expect(detalles(avion.otros_gastos.filas)).not.toContain('Nómina');
    expect(general.consolidado.pendientes).toContain(
      'Nómina sin repartir: 2 pagos por $2,000 MXN y $100 USD — no entra a ningún balance hasta repartirla entre aviones (módulo Nómina).',
    );
  });

  it('los demás números NO cambian: el general y el avión con la nómina sin repartir = sin ninguna nómina (salvo el aviso)', async () => {
    const con = await libros(SIN_REPARTO);
    const sin = await libros([]);
    expect(sinSello(con.general.gastos_empresa)).toEqual(
      sinSello(sin.general.gastos_empresa),
    );
    expect(sinSello(con.general.empresa)).toEqual(
      sinSello(sin.general.empresa),
    );
    expect(sinSello(con.general.aviones)).toEqual(
      sinSello(sin.general.aviones),
    );
    expect(sinSello(con.avion)).toEqual(sinSello(sin.avion));
    const extra = con.general.consolidado.pendientes.filter(
      (p) => !sin.general.consolidado.pendientes.includes(p),
    );
    expect(extra).toEqual([
      'Nómina sin repartir: 2 pagos por $2,000 MXN y $100 USD — no entra a ningún balance hasta repartirla entre aviones (módulo Nómina).',
    ]);
    // Sin nómina no hay aviso.
    expect(
      sin.general.consolidado.pendientes.some((p) =>
        p.startsWith('Nómina sin repartir'),
      ),
    ).toBe(false);
  });

  it('REPARTIDA: igual que siempre — parciales a «Gastos Indirectos» del avión y el REMANENTE del parcial a «otros gastos»', async () => {
    const { general, avion } = await libros([...SIN_REPARTO, ...REPARTIDAS]);
    // «otros gastos» del general: el OTRO de 700 + el remanente de 300.
    expect(general.gastos_empresa.total_mxn).toBe(1000);
    const remanente = general.gastos_empresa.filas.find((f) =>
      (f.detalle ?? '').includes('remanente de reparto'),
    );
    expect(remanente?.monto_mxn).toBe(300);
    expect(remanente?.gasto_id).toBe('g-nom-parcial');
    // Hoja «Gastos Indirectos» del avión: 1,000 + 600 de parciales.
    const parciales = avion.gastos_indirectos.filas.filter((f) =>
      (f.detalle ?? '').includes('Nómina'),
    );
    expect(parciales.map((f) => f.monto_mxn).sort()).toEqual([1000, 600]);
    // El aviso solo cuenta las SIN reparto.
    expect(
      general.consolidado.pendientes.filter((p) =>
        p.startsWith('Nómina sin repartir'),
      ),
    ).toEqual([
      'Nómina sin repartir: 2 pagos por $2,000 MXN y $100 USD — no entra a ningún balance hasta repartirla entre aviones (módulo Nómina).',
    ]);
  });
});
