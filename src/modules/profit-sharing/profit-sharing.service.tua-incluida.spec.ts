// AFAC POR VUELO (16-oct-2026, invariante 90): este spec congela la conducta
// SIN la migración 20261016000005 (0.0.88); la conducta con ella vive en los
// specs `*.afac*.spec.ts` (o en los casos que la encienden abajo).
jest.mock('../../common/afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/afac-real-disponible.util',
  ),
  afacRealDisponible: jest.fn(() => Promise.resolve(false)),
}));
// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * REPARTO A SOCIOS con la TUA de la OFICINA (13-oct-2026, TUA sistémica,
 * invariante 66): `computeAvion` no cambió — `trasladosEmbebidosDeGasto`
 * recibe la fila entera y la TUA fijada manda sobre la lectura: la fila
 * informativa «TUA embebido (excluido)» y el costo DIRECTO del avión salen
 * del MISMO número que el Balance. `fetchGastos` lee la columna SOLO detrás
 * de la sonda.
 */
type Fila = Record<string, unknown>;

const AV = 'av-1';
const VUELO = 'v-1';

type Privado = {
  computeAvion: (
    a: { id: string; matricula: string; modelo: string },
    ctx: Record<string, unknown>,
  ) => {
    gastos: { directos_usd: number };
    detalle: {
      gastos_por_categoria: Array<{
        categoria: string;
        grupo: string;
        usd: number;
      }>;
    };
  };
  fetchGastos: (desde: string, hasta: string) => Promise<Fila[]>;
};

function armar(supabase?: SupabaseService) {
  const nada = {} as never;
  return new ProfitSharingService(
    supabase ??
      ({ service: { from: () => ({}) } } as unknown as SupabaseService),
    nada,
    nada,
    nada,
  ) as unknown as Privado;
}

const gastoBase = {
  escala_id: null,
  aeronave_id: AV,
  vuelo_id: VUELO,
  moneda: 'USD',
  tc_gasto: null,
  propina: null,
  notas: null,
  fecha_gasto: '2026-10-06',
};

const LECTURA_383 = {
  conceptos: [
    { concepto: 'Operaciones', monto: 1365.64 },
    { concepto: 'Autobuses', monto: 559.63 },
  ],
};
const LECTURA_TARIFA_TUA = {
  conceptos: [
    { concepto: 'Operaciones', monto: 554.41 },
    { concepto: 'Tarifa TUA', monto: 1119.26 },
  ],
};

function computar(gastos: Fila[]) {
  return armar().computeAvion(
    { id: AV, matricula: 'XB-TST', modelo: 'C206' },
    {
      vuelos: [],
      cobrosPorVuelo: new Map(),
      horasPorAvion: new Map(),
      participacionPorVuelo: new Map(),
      escalaPorId: new Map(),
      escalasPorVuelo: new Map(),
      vueloAvion: new Map([[VUELO, AV]]),
      matriculas: new Map([[AV, 'XB-TST']]),
      clientes: new Map(),
      gastos,
      socios: [],
      reservas: [],
      nombres: new Map(),
      otrosPorAvion: 0,
      periodo: { desde: '2026-10-01', hasta: '2026-10-31' },
      tcOficialVuelo: new Map(),
      tcOficialGasto: new Map(),
      tcKComisionesVuelo: new Map(),
      vigenciaComisiones: '2026-09-01',
      gastosVendedorPorVuelo: new Map(),
      vuelosConPagoVendedorAvion: new Set<string>(),
    },
  );
}

const fila = (r: ReturnType<typeof computar>, clave: string) =>
  r.detalle.gastos_por_categoria.find((x) => x.categoria === clave);

describe('Reparto — TUA de la oficina (13-oct-2026)', () => {
  it('OPERACIONES con TUA fijada 700 ⇒ fila «TUA embebido (excluido)» de 700 y costo DIRECTO = monto − 700', () => {
    const r = computar([
      {
        ...gastoBase,
        id: 'g-383',
        categoria: 'OPERACIONES',
        monto: '1925.27',
        valor_ia_extraido: LECTURA_383,
        tua_incluida: '700.00',
      },
    ]);
    expect(r.gastos.directos_usd).toBe(1225.27);
    expect(fila(r, 'OPERACIONES')).toMatchObject({
      grupo: 'DIRECTO',
      usd: 1225.27,
    });
    expect(fila(r, 'TUA embebido (excluido)')).toMatchObject({
      grupo: 'EXCLUIDO',
      usd: 700,
    });
  });

  it('control: la MISMA factura sin override ni señal ⇒ costo entero y sin fila informativa (lo de hoy)', () => {
    const r = computar([
      {
        ...gastoBase,
        id: 'g-383',
        categoria: 'OPERACIONES',
        monto: '1925.27',
        valor_ia_extraido: LECTURA_383,
      },
    ]);
    expect(r.gastos.directos_usd).toBe(1925.27);
    expect(fila(r, 'TUA embebido (excluido)')).toBeUndefined();
  });

  it('TUA fijada 0 sobre un renglón «Tarifa TUA» ⇒ sin fila informativa y costo entero', () => {
    const conRenglon = {
      ...gastoBase,
      id: 'g-asur',
      categoria: 'OPERACIONES',
      monto: '1673.67',
      valor_ia_extraido: LECTURA_TARIFA_TUA,
    };
    // Control: la lectura sola separa 1,119.26.
    const leida = computar([conRenglon]);
    expect(leida.gastos.directos_usd).toBe(554.41);
    expect(fila(leida, 'TUA embebido (excluido)')?.usd).toBe(1119.26);
    const anulada = computar([{ ...conRenglon, tua_incluida: '0.00' }]);
    expect(anulada.gastos.directos_usd).toBe(1673.67);
    expect(fila(anulada, 'TUA embebido (excluido)')).toBeUndefined();
  });
});

describe('fetchGastos — la columna detrás de la sonda', () => {
  function supabase(sinMigracion: boolean) {
    const selects: string[] = [];
    const from = () => {
      let cols = '';
      const q: Record<string, unknown> = {
        select: (c: string) => {
          cols = c;
          selects.push(c);
          return q;
        },
        gte: () => q,
        lte: () => q,
        limit: () => q,
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            cols === 'tua_incluida' && sinMigracion
              ? {
                  data: null,
                  error: {
                    code: '42703',
                    message: 'column gasto.tua_incluida does not exist',
                  },
                }
              : { data: [], error: null },
          ).then(res),
      };
      return q;
    };
    return {
      sb: { service: { from } } as unknown as SupabaseService,
      selects,
    };
  }

  it('con la migración el select la nombra; sin ella, no', async () => {
    const con = supabase(false);
    await armar(con.sb).fetchGastos('2026-10-01', '2026-10-31');
    expect(con.selects.filter((s) => s !== 'tua_incluida')).toEqual([
      'id, aeronave_id, vuelo_id, escala_id, categoria, monto, moneda, tc_gasto, propina, valor_ia_extraido, notas, fecha_gasto, tua_incluida',
    ]);
    const sin = supabase(true);
    await armar(sin.sb).fetchGastos('2026-10-01', '2026-10-31');
    expect(sin.selects.filter((s) => s !== 'tua_incluida')).toEqual([
      'id, aeronave_id, vuelo_id, escala_id, categoria, monto, moneda, tc_gasto, propina, valor_ia_extraido, notas, fecha_gasto',
    ]);
  });
});
