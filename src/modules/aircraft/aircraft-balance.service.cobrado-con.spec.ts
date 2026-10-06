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
  BalanceAvionCobroPayload,
  BalanceAvionPayload,
  BalanceAvionVueloPayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  V1,
  fakeSupabase,
  mundoLibros,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * «CÓMO SE COBRÓ» CADA PARCIALIDAD (6-oct-2026, API 0.0.60). Pedido del
 * cliente con el Excel «reporte horas FLOTA»: «Al lado de la columna STATUS,
 * si ya se pagó, que venga la misma información de cómo se cobró, quién lo
 * cobró y, si es posible, a qué cuenta».
 *
 * Contrato: cada cobro de `vuelos[].cobros` gana, AL FINAL y sin mover nada
 * más, `metodo_etiqueta` (etiqueta humana, con el sufijo de parte en
 * multi-avión), `registro` (nombre de quien registró, por el embed
 * `registro:usuario!registrado_por(nombre)` de la MISMA consulta) y
 * `cobrado_con` (la línea armada por `etiquetaCobradoCon`).
 */

const AV2 = 'av-2';
const V3 = 'v-3';

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

/** Cobro con los datos de «cómo se cobró» (forma del select del balance). */
function cobro(
  id: string,
  vueloId: string,
  extra: Fila & { fecha: string },
): Fila {
  const { fecha, ...resto } = extra;
  return {
    id,
    vuelo_id: vueloId,
    moneda: 'MXN',
    tc_usd_mxn: 20,
    fecha_cobro: fecha,
    comision_banco_monto: null,
    comision_banco_pct: null,
    metodo_cobro: null,
    cuenta_destino: null,
    registrado_por: null,
    registro: null,
    ...resto,
  };
}

/**
 * El mundo de los libros con los cobros del #501 reales en su forma:
 * - c-1 TRANSFERENCIA a Scotiabank Pesos que registró Itzi (cobro completo);
 * - c-2 EFECTIVO sin cuenta que registró Pablo Canales (embed en ARREGLO);
 * - c-3 TRANSFERENCIA a HSBC Dólares de un usuario BORRADO (embed null).
 * Y un #503 MULTI-AVIÓN (AV principal + un tramo del AV2) cobrado por
 * transferencia a Scotiabank Pesos, registró Itzi.
 */
function mundoCobros(): Record<string, Fila[]> {
  const m = mundoLibros();
  const f3 = '2026-09-15T15:00:00+00:00';
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
        monto_total_usd: 2000,
        monto_total_mxn: 36000,
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
      cobro('c-1', V1, {
        fecha: '2026-09-10T16:00:00+00:00',
        monto: 20000,
        comision_banco_monto: 350,
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'Scotiabank Pesos',
        registrado_por: 'u-itzi',
        registro: { nombre: 'Itzi' },
      }),
      cobro('c-2', V1, {
        fecha: '2026-09-11T16:00:00+00:00',
        monto: 10000,
        metodo_cobro: 'EFECTIVO',
        cuenta_destino: '  ',
        registrado_por: 'u-pablo',
        registro: [{ nombre: ' Pablo   Canales ' }],
      }),
      cobro('c-3', V1, {
        fecha: '2026-09-12T16:00:00+00:00',
        monto: 500,
        moneda: 'USD',
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'HSBC Dólares',
        registrado_por: null,
        registro: null,
      }),
      cobro('c-4', V3, {
        fecha: '2026-09-15T20:00:00+00:00',
        monto: 36000,
        tc_usd_mxn: 18,
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'Scotiabank Pesos',
        registrado_por: 'u-itzi',
        registro: { nombre: 'Itzi' },
      }),
    ],
  };
}

/** Supabase del mundo + registro del `select` pedido a `cobro_vuelo`. */
function supabaseCon(mundo: Record<string, Fila[]>) {
  const base = fakeSupabase(mundo);
  const selectsCobro: string[] = [];
  const from = (tabla: string) => {
    const q = base.supabase.service.from(tabla);
    if (tabla === 'cobro_vuelo') {
      const selectOriginal = q.select as (cols?: string) => unknown;
      q.select = (cols?: string) => {
        selectsCobro.push(cols ?? '');
        return selectOriginal(cols);
      };
    }
    return q;
  };
  return { supabase: { service: { from } }, selectsCobro };
}

function armar(mundo: Record<string, Fila[]>) {
  const s = supabaseCon(mundo);
  const enviados: { individual?: BalanceAvionPayload; general?: unknown } = {};
  const pyservices = {
    generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
      enviados.individual = p;
      return Promise.resolve(Buffer.from('xlsx'));
    },
    generateBalanceGeneralXlsx: (p: unknown) => {
      enviados.general = p;
      return Promise.resolve(Buffer.from('xlsx'));
    },
  };
  const service = new AircraftBalanceService(
    s.supabase as unknown as SupabaseService,
    pyservices as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  return { service, enviados, selectsCobro: s.selectsCobro };
}

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
};

const filaDe = (
  vuelos: BalanceAvionVueloPayload[],
  vueloId: string,
): BalanceAvionVueloPayload => {
  const f = vuelos.find((x) => x.vuelo_id === vueloId);
  if (!f) throw new Error(`sin fila del vuelo ${vueloId}`);
  return f;
};

/** Lo que el cliente ve de cada cobro, en el orden del libro. */
const comoSeCobro = (cobros: BalanceAvionCobroPayload[]) =>
  cobros.map((c) => ({
    metodo: c.metodo,
    cuenta: c.cuenta,
    metodo_etiqueta: c.metodo_etiqueta,
    registro: c.registro,
    cobrado_con: c.cobrado_con,
  }));

/** Payload sin lo que cambia entre corridas (sello de generación). */
const sinSello = (p: BalanceAvionPayload) => ({ ...p, generado: null });

describe('Balance por avión — «cómo se cobró» cada parcialidad (6-oct-2026, API 0.0.60)', () => {
  it('cobro completo, sin cuenta y sin registro: método → cuenta · Registró: nombre', async () => {
    const { service, enviados } = armar(mundoCobros());
    await service.xlsx(AV, DESDE, HASTA);
    const fila = filaDe(enviados.individual!.vuelos, V1);
    expect(comoSeCobro(fila.cobros)).toEqual([
      {
        metodo: 'TRANSFERENCIA',
        cuenta: 'Scotiabank Pesos',
        metodo_etiqueta: 'Transferencia',
        registro: 'Itzi',
        cobrado_con: 'Transferencia → Scotiabank Pesos · Registró: Itzi',
      },
      {
        // Cuenta en blanco = sin cuenta; el embed en arreglo también se lee
        // y el nombre sale limpio.
        metodo: 'EFECTIVO',
        cuenta: null,
        metodo_etiqueta: 'Efectivo',
        registro: 'Pablo Canales',
        cobrado_con: 'Efectivo · Registró: Pablo Canales',
      },
      {
        // Usuario borrado (FK on delete set null ⇒ embed null): sin
        // «Registró», jamás un nombre inventado.
        metodo: 'TRANSFERENCIA',
        cuenta: 'HSBC Dólares',
        metodo_etiqueta: 'Transferencia',
        registro: null,
        cobrado_con: 'Transferencia → HSBC Dólares',
      },
    ]);
  });

  it('los campos nuevos van AL FINAL de cada cobro (aditivos)', async () => {
    const { service, enviados } = armar(mundoCobros());
    await service.xlsx(AV, DESDE, HASTA);
    const c = filaDe(enviados.individual!.vuelos, V1).cobros[0];
    expect(Object.keys(c)).toEqual([
      'fecha',
      'monto_mxn',
      'metodo',
      'comision_mxn',
      'cuenta',
      'metodo_etiqueta',
      'registro',
      'cobrado_con',
    ]);
  });

  it('cobro sin método, cuenta ni registro (fixture de siempre): los tres en null', async () => {
    const { service, enviados } = armar(mundoLibros());
    await service.xlsx(AV, DESDE, HASTA);
    const fila = filaDe(enviados.individual!.vuelos, V1);
    expect(fila.cobros.length).toBe(2);
    for (const c of fila.cobros) {
      expect(c.metodo).toBeNull();
      expect(c.metodo_etiqueta).toBeNull();
      expect(c.registro).toBeNull();
      expect(c.cobrado_con).toBeNull();
    }
  });

  it('el nombre viaja en la MISMA consulta de cobros (embed por la FK registrado_por)', async () => {
    const { service, selectsCobro } = armar(mundoCobros());
    await service.xlsx(AV, DESDE, HASTA);
    expect(selectsCobro).toHaveLength(1);
    expect(selectsCobro[0]).toContain('registrado_por');
    expect(selectsCobro[0]).toContain(
      'registro:usuario!registrado_por(nombre)',
    );
    // Las columnas de siempre siguen ahí.
    for (const col of [
      'metodo_cobro',
      'cuenta_destino',
      'comision_banco_monto',
      'fecha_cobro',
    ]) {
      expect(selectsCobro[0]).toContain(col);
    }
  });

  it('quién registró NO mueve ningún número: con y sin registro el payload es idéntico salvo `registro` y `cobrado_con`', async () => {
    const con = armar(mundoCobros());
    await con.service.xlsx(AV, DESDE, HASTA);
    const mundoSin = mundoCobros();
    mundoSin.cobro_vuelo = mundoSin.cobro_vuelo.map((c) => ({
      ...c,
      registrado_por: null,
      registro: null,
    }));
    const sin = armar(mundoSin);
    await sin.service.xlsx(AV, DESDE, HASTA);
    const quitar = (p: BalanceAvionPayload) =>
      sinSello({
        ...p,
        vuelos: p.vuelos.map((f) => ({
          ...f,
          cobros: f.cobros.map((c) => ({
            ...c,
            registro: null,
            cobrado_con: null,
          })),
        })),
      });
    const pSin = sin.enviados.individual!;
    expect(filaDe(pSin.vuelos, V1).cobros.map((c) => c.cobrado_con)).toEqual([
      'Transferencia → Scotiabank Pesos',
      'Efectivo',
      'Transferencia → HSBC Dólares',
    ]);
    expect(quitar(con.enviados.individual!)).toEqual(quitar(pSin));
  });

  it('multi-avión: `metodo_etiqueta` lleva el MISMO sufijo de parte que `metodo` y `cobrado_con` lo pone al final', async () => {
    const { service, enviados } = armar(mundoCobros());
    await service.xlsx(AV, DESDE, HASTA);
    const fila = filaDe(enviados.individual!.vuelos, V3);
    expect(fila.cobros).toHaveLength(1);
    const c = fila.cobros[0];
    expect(c.metodo).toBe(
      'TRANSFERENCIA · parte de esta fila (50 % de la venta del avión)',
    );
    expect(c.metodo_etiqueta).toBe(
      'Transferencia · parte de esta fila (50 % de la venta del avión)',
    );
    expect(c.cuenta).toBe('Scotiabank Pesos');
    expect(c.registro).toBe('Itzi');
    expect(c.cobrado_con).toBe(
      'Transferencia → Scotiabank Pesos · Registró: Itzi · parte de esta fila (50 % de la venta del avión)',
    );
  });
});

describe('Balance GENERAL — «cómo se cobró» en los dos libros y en el consolidado', () => {
  it('multi-avión: cada libro lleva su fila con la parte y el consolidado hereda los campos', async () => {
    const { service, enviados } = armar(mundoCobros());
    await service.xlsxGeneral(DESDE, HASTA);
    const g = enviados.general as General;
    const esperado =
      'Transferencia → Scotiabank Pesos · Registró: Itzi · parte de esta fila (50 % de la venta del avión)';
    const porLibro = Object.fromEntries(
      g.aviones.map((p) => [
        p.matricula,
        filaDe(p.vuelos, V3).cobros.map((c) => c.cobrado_con),
      ]),
    );
    expect(porLibro).toEqual({
      'XB-DOS': [esperado],
      'XB-TST': [esperado],
    });
    const consolidadoV3 = g.consolidado.vuelos
      .filter((f) => f.vuelo_id === V3)
      .map((f) => f.cobros.map((c) => [c.metodo_etiqueta, c.cobrado_con]));
    expect(consolidadoV3).toEqual([
      [
        [
          'Transferencia · parte de esta fila (50 % de la venta del avión)',
          esperado,
        ],
      ],
      [
        [
          'Transferencia · parte de esta fila (50 % de la venta del avión)',
          esperado,
        ],
      ],
    ]);
    // El vuelo de un solo avión, igual que en el libro individual.
    const deV1 = filaDe(g.consolidado.vuelos, V1).cobros.map(
      (c) => c.cobrado_con,
    );
    expect(deV1).toEqual([
      'Transferencia → Scotiabank Pesos · Registró: Itzi',
      'Efectivo · Registró: Pablo Canales',
      'Transferencia → HSBC Dólares',
    ]);
  });
});
