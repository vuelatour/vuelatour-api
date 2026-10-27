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
  BalanceGeneralResumenFilaPayload,
} from '../pyservices/pyservices.service';
import {
  DESDE,
  HASTA,
  fakeSupabase,
  gastoBase,
  mundoLibros,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004; la conducta con la migración vive en los
// specs `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

/**
 * VUELOS CON AVIONES EXTERNOS en el bloque «VUELATOUR (empresa)» del
 * Balance general (27-oct-2026, API 0.0.112, invariante 112). Pedido del
 * cliente: «me falta en el balance de VuelaTour los vuelos con aviones
 * externos … cuánto dejaron de ingreso, cuánto de gastos y al final la
 * utilidad, y un resumen a un lado de cuántos fueron». El general ya
 * construye el libro EXTERNOS (vuelos de operador ajeno SIN avión); el
 * bloque lo CITA: ingreso = su VENTA, utilidad = su UTILIDAD DESPUÉS DE
 * GASTOS (suma en el RESULTADO), gastos = lo de en medio. Arnés copiado de
 * `aircraft-balance.service.bloque-empresa.spec.ts`.
 */

const TC_OFICIAL = 25;
const CONFIG_VIGENCIA_POSTERIOR = {
  fecha: () => Promise.resolve('2026-12-01'),
};

/** #503: el #453 de prod en septiembre (Simon Herrera, 950 USD, K 18.4888). */
const V3 = 'v-3';
const F3 = '2026-09-25T15:00:00+00:00';
const K3 = 18.4888;
const vueloExterno: Fila = {
  id: V3,
  folio: 503,
  cliente_id: 'cli-2',
  aeronave_id: null,
  estado: 'COMPLETADO',
  tipo: 'CHARTER',
  es_externo: true,
  operador_externo: 'Simon Herrera',
  costo_externo_usd: '840.00',
  fecha_vuelo: F3,
  fecha_solicitud: null,
  fecha_traslado_final: null,
  origen_iata: 'CUN',
  destino_iata: 'HOL',
  tiempo_cobrable_hr: 1,
  tarifa_hora_usd: 950,
  iva_pct: 0,
  iva_usd: 0,
  subtotal_vuelo_usd: 950,
  ajuste_final_usd: 0,
  tuas_usd: 0,
  extras_total_usd: 0,
  viaticos_pernocta_usd: 0,
  comision_vendedor_usd: 0,
  comision_vendedor_nombre: null,
  monto_total_usd: 950,
  monto_total_mxn: 17564.36,
  tc_usd_mxn: K3,
  cobrado: true,
  calculo_snapshot: null,
  cliente: { nombre: 'Oscar Dos' },
};

/** Pago al operador MARCADO (invariante 110): cubre el costo cotizado. */
const pagoSimon: Fila = {
  ...gastoBase,
  id: 'g-simon',
  vuelo_id: V3,
  vuelo: { folio: 503, aeronave_id: null, es_externo: true },
  categoria: 'OPERACIONES',
  monto: 18182,
  fecha_gasto: '2026-09-26',
  created_at: '2026-09-26T19:00:00+00:00',
  notas: 'pago a simon del vuelo a holbox',
  es_pago_operador_externo: true,
};

function mundo(conExterno: boolean): Record<string, Fila[]> {
  const m = mundoLibros();
  if (!conExterno) return m;
  return {
    ...m,
    cliente: [...m.cliente, { id: 'cli-2', nombre: 'Oscar Dos' }],
    vuelo: [...m.vuelo, vueloExterno],
    escala: [
      ...m.escala,
      {
        id: 'e-3',
        vuelo_id: V3,
        orden: 1,
        aeronave_id: null,
        cancelada_at: null,
        taco_salida: null,
        taco_llegada: null,
        solo_operativa: false,
        es_ferry: false,
        origen_iata: 'CUN',
        destino_iata: 'HOL',
        es_sobrevuelo: false,
        tipo_parada: 'NORMAL',
        pasajeros: 2,
        fecha_salida_plan: F3,
        vuelo: { fecha_vuelo: F3, aeronave_id: null },
      },
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      {
        id: 'c-3',
        vuelo_id: V3,
        monto: 950,
        moneda: 'USD',
        tc_usd_mxn: K3,
        fecha_cobro: '2026-09-27T16:00:00+00:00',
        comision_banco_monto: null,
      },
    ],
    gasto: [...m.gasto, pagoSimon],
  };
}

type General = {
  resumen: BalanceGeneralResumenFilaPayload[];
  aviones: BalanceAvionPayload[];
  empresa?: BalanceEmpresaBloquePayload;
};

async function general(m: Record<string, Fila[]>): Promise<General> {
  const f = fakeSupabase(m);
  const enviados: { general?: General } = {};
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: () => Promise.resolve(Buffer.from('xlsx')),
      generateBalanceGeneralXlsx: (p: General) => {
        enviados.general = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    {
      oficialDetallePara: (dia: string) =>
        Promise.resolve({
          tc: TC_OFICIAL,
          fecha_dato: dia,
          fuente: 'OPEN_ER_API',
        }),
    } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
    CONFIG_VIGENCIA_POSTERIOR as never,
  );
  await service.xlsxGeneral(DESDE, HASTA);
  return enviados.general!;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

describe('Balance GENERAL — vuelos con aviones externos en el bloque VUELATOUR (27-oct-2026)', () => {
  it('sin libro EXTERNOS: el bloque de siempre, SIN la llave', async () => {
    const g = await general(mundo(false));
    expect(g.resumen.some((r) => r.matricula === 'EXTERNOS')).toBe(false);
    expect('externos' in g.empresa!).toBe(false);
    expect(typeof g.empresa!.resultado_mxn).toBe('number');
  });

  it('con un externo sin avión: ingreso = su VENTA, gastos = el pago al operador UNA vez (invariante 110), utilidad = ganancia; suma en el RESULTADO', async () => {
    const sin = await general(mundo(false));
    const con = await general(mundo(true));
    expect(con.resumen.some((r) => r.matricula === 'EXTERNOS')).toBe(true);
    // El libro EXTERNOS no genera bloque de avión: `aviones` no cambia.
    expect(con.aviones.map((a) => a.matricula)).toEqual(
      sin.aviones.map((a) => a.matricula),
    );
    const e = con.empresa!.externos!;
    expect(e.vuelos).toBe(1);
    expect(e.cancelados).toBe(0);
    expect(e.operadores).toEqual(['Simon Herrera']);
    expect(e.ingreso_mxn).toBeCloseTo(r2(950 * K3), 2); // 17,564.36
    expect(e.gastos_mxn).toBeCloseTo(18182, 2); // no 15,530.59 + 18,182
    expect(e.utilidad_mxn).toBeCloseTo(r2(950 * K3 - 18182), 2); // −617.64
    expect(e.hojas_mxn).toBe(0);
    expect(e.por_cobrar_mxn).toBe(0);
    expect(e.sin_pesos).toEqual([]);
    expect(e.detalle).toHaveLength(1);
    expect(e.detalle[0]).toMatchObject({
      folio: '503',
      operador: 'Simon Herrera',
      estado: 'COMPLETADO',
      cancelado: false,
      cliente: 'Oscar Dos',
      gastos_mxn: 18182,
      por_cobrar_mxn: 0,
    });
    expect(e.detalle[0].clave).toContain('503');
    expect(e.detalle[0].utilidad_mxn).toBeCloseTo(-617.64, 2);
    expect(e.nota).toContain('1 vuelo con Simon Herrera.');
    // USD informativo: la cascada USD del libro EXTERNOS (el gasto en pesos
    // va a USD gasto por gasto, invariante 96: con el T.C. oficial del día,
    // no con el K de la venta).
    expect(e.ingreso_usd).toBe(950);
    expect(e.utilidad_usd).toBeCloseTo(r2(950 - 18182 / TC_OFICIAL), 2);
    // El RESULTADO en pesos sube (aquí baja) EXACTAMENTE por esa utilidad; el
    // resto del bloque (participación, propios, otros gastos) no se mueve.
    expect(con.empresa!.resultado_mxn).toBeCloseTo(
      r2(sin.empresa!.resultado_mxn! + e.utilidad_mxn!),
      2,
    );
    expect(con.empresa!.ingresos_propios_mxn).toBe(
      sin.empresa!.ingresos_propios_mxn,
    );
    expect(con.empresa!.pagos_vendedor_mxn).toBe(
      sin.empresa!.pagos_vendedor_mxn,
    );
    expect(con.empresa!.otros_gastos_empresa_mxn).toBe(
      sin.empresa!.otros_gastos_empresa_mxn,
    );
    expect(Object.keys(con.empresa!).at(-1)).toBe('externos');
  });
});
