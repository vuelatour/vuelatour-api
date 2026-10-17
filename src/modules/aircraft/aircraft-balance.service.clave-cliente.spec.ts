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
// El lector del ID por cliente se reemplaza: aquí se prueba SOLO la
// etiqueta de la CLAVE (la BD del lector tiene su propio spec).
jest.mock('../../common/clave-cliente-lectura.util', () => ({
  clavesClienteDeVuelos: jest.fn(),
  vueloIdsPorClaveCliente: jest.fn().mockResolvedValue([]),
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import { clavesClienteDeVuelos } from '../../common/clave-cliente-lectura.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceHojaOtrosMovimientosPayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  INGRESOS_LIBROS,
  V1,
  fakeSupabase,
  gastoBase,
  mundoLibros,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004 (0.0.87 byte a byte); la conducta con la
// migración vive en los specs `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

/**
 * ID DE VUELO POR CLIENTE EN LOS LIBROS DEL BALANCE (13-oct-2026, API
 * 0.0.75, invariante 68). SOLO ETIQUETAS: la CLAVE de la maestra/cobranza
 * pasa a «#364 · beh05-011026 · Beh Kay » (`claveLibro`), la de «otros
 * movimientos» a «#364 · beh05-011026» (`claveOtrosMovimientos`; sin ID,
 * «vtbeh364») y `clave_cliente` viaja SOLO con valor. Ningún importe, T.C.,
 * partición ni total cambia.
 *
 * Mundo: el de los libros con el vuelo #501 re-etiquetado como el #364 de
 * prod (cliente «Beh Kay », con su espacio), tarifa AFAC en el XB-TST, un
 * segundo avión XB-DOS y el #503 MULTI-AVIÓN de «January Davila» (un tramo
 * en cada avión).
 */

const lector = clavesClienteDeVuelos as jest.MockedFunction<
  typeof clavesClienteDeVuelos
>;

const AV2 = 'av-2';
const V3 = 'v-3';
const CLAVES: Record<string, string> = {
  [V1]: 'beh05-011026',
  [V3]: 'january02-211026',
};

/** El lector: SOLO las claves de los ids pedidos (como el real). */
function lectorCon(claves: Record<string, string>) {
  lector.mockImplementation((_sb, ids) =>
    Promise.resolve(
      new Map(
        [...new Set(ids)]
          .filter((id): id is string => !!id && claves[id] != null)
          .map((id) => [id, claves[id]] as [string, string]),
      ),
    ),
  );
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

function mundo(): Record<string, Fila[]> {
  const m = mundoLibros(INGRESOS_LIBROS);
  const f3 = '2026-09-15T15:00:00+00:00';
  const v1 = {
    ...m.vuelo[0],
    folio: 364,
    cliente: { nombre: 'Beh Kay ' },
  };
  const v3 = vuelo2({
    id: V3,
    folio: 503,
    cliente_id: 'cli-2',
    cliente: { nombre: 'January Davila' },
    fecha_vuelo: f3,
    tiempo_cobrable_hr: 2,
    subtotal_vuelo_usd: 2000,
    monto_total_usd: 2000,
    monto_total_mxn: 36000,
  });
  return {
    ...m,
    aeronave: [
      // Tarifa AFAC: la fila «AFAC · XB-TST» cita la CLAVE de la maestra.
      { ...m.aeronave[0], permiso_afac_usd_hr: 25 },
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
    cliente: [
      { id: 'cli-1', nombre: 'Beh Kay ' },
      { id: 'cli-2', nombre: 'January Davila' },
    ],
    vuelo: [v1, v3],
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
    gasto: [
      ...m.gasto,
      // Un permiso pagado del XB-TST (lado egreso de la fila AFAC).
      {
        ...gastoBase,
        id: 'g-permiso',
        aeronave_id: AV,
        categoria: 'PERMISO',
        monto: 900,
        notas: 'AFAC',
      },
    ],
  };
}

type General = {
  consolidado: BalanceAvionPayload & {
    otros_movimientos: BalanceHojaOtrosMovimientosPayload;
  };
  aviones: BalanceAvionPayload[];
};

function armar() {
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const service = new AircraftBalanceService(
    fakeSupabase(mundo()).supabase as unknown as SupabaseService,
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
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  return { service, enviados };
}

async function individual(): Promise<BalanceAvionPayload> {
  const { service, enviados } = armar();
  await service.xlsx(AV, DESDE, HASTA);
  return enviados.individual!;
}

async function general(): Promise<General> {
  const { service, enviados } = armar();
  await service.xlsxGeneral(DESDE, HASTA);
  return enviados.general!;
}

/**
 * El payload sin lo que ESTE cambio toca (la CLAVE, `clave_cliente`, el ID
 * citado en la nota AFAC) ni los sellos: con y sin ID debe ser IDÉNTICO.
 */
const sinEtiquetas = (p: unknown) =>
  JSON.stringify(p, (llave: string, valor: unknown) => {
    if (llave === 'clave' || llave === 'clave_cliente' || llave === 'generado')
      return undefined;
    return typeof valor === 'string'
      ? valor.replace(/ · (beh05-011026|january02-211026)/g, '')
      : valor;
  });

describe('Balance por avión — CLAVE con el ID de vuelo por cliente (invariante 68)', () => {
  beforeEach(() => lector.mockReset());

  it('hoja maestra (y cobranza, misma fila): «#364 · beh05-011026 · Beh Kay » + clave_cliente AL FINAL', async () => {
    lectorCon(CLAVES);
    const p = await individual();
    const f364 = p.vuelos.find((v) => v.vuelo_id === V1)!;
    expect(f364.clave).toBe('#364 · beh05-011026 · Beh Kay ');
    expect(f364.clave_cliente).toBe('beh05-011026');
    expect(Object.keys(f364).at(-1)).toBe('clave_cliente');
    // El lector se pidió UNA vez con los vuelos del libro.
    expect(lector).toHaveBeenCalledTimes(1);
    expect([...(lector.mock.calls[0][1] as string[])].sort()).toEqual(
      [V1, V3].sort(),
    );
  });

  it('lector vacío (sin migración o lectura fallida) ⇒ la CLAVE de siempre y NINGUNA llave clave_cliente', async () => {
    lectorCon({});
    const p = await individual();
    const f364 = p.vuelos.find((v) => v.vuelo_id === V1)!;
    expect(f364.clave).toBe('#364 · Beh Kay ');
    expect(JSON.stringify(p)).not.toContain('clave_cliente');
  });

  it('ningún número cambia: con y sin ID el libro es idéntico fuera de las etiquetas', async () => {
    lectorCon(CLAVES);
    const con = await individual();
    lectorCon({});
    const sin = await individual();
    expect(con.vuelos.length).toBeGreaterThan(0);
    expect(sinEtiquetas(con)).toBe(sinEtiquetas(sin));
  });
});

describe('Balance GENERAL — CLAVE con el ID en libros, consolidado y «otros movimientos»', () => {
  beforeEach(() => lector.mockReset());

  it('la MISMA clave en aviones[] y en el consolidado FLOTA; multi-avión: la misma en las filas de los dos libros', async () => {
    lectorCon(CLAVES);
    const g = await general();
    const porLibro = Object.fromEntries(
      g.aviones.map((p) => [
        p.matricula,
        p.vuelos.map((v) => [v.clave, v.clave_cliente]),
      ]),
    );
    expect(porLibro['XB-DOS']).toEqual([
      ['#503 · january02-211026 · January Davila', 'january02-211026'],
    ]);
    expect(porLibro['XB-TST']).toEqual(
      expect.arrayContaining([
        ['#364 · beh05-011026 · Beh Kay ', 'beh05-011026'],
        ['#503 · january02-211026 · January Davila', 'january02-211026'],
      ]),
    );
    const flota = g.consolidado.vuelos.map((v) => [v.clave, v.clave_cliente]);
    expect(flota).toHaveLength(3);
    expect(flota.filter((c) => c[1] === 'january02-211026')).toHaveLength(2);
    expect(flota).toContainEqual([
      '#364 · beh05-011026 · Beh Kay ',
      'beh05-011026',
    ]);
  });

  it('«otros movimientos»: «#364 · beh05-011026» con clave_cliente, también tras COLAPSAR varias líneas del vuelo', async () => {
    lectorCon(CLAVES);
    const g = await general();
    const om = g.consolidado.otros_movimientos;
    const f364 = om.filas.find((f) => f.clave.startsWith('#364'))!;
    expect(f364.clave).toBe('#364 · beh05-011026');
    expect(f364.clave_cliente).toBe('beh05-011026');
    // El #364 trae TUAS + comisión + extras: la fila es la COLAPSADA.
    expect(f364.concepto_ingreso).toContain('conceptos (ver nota)');
    // Sueltas (TUAS sin vuelo, gas sin avión, ING-n): sin la llave.
    for (const f of om.filas_sueltas) {
      expect(f).not.toHaveProperty('clave_cliente');
    }
    expect(om.filas_sueltas.map((f) => f.clave)).toEqual(
      expect.arrayContaining(['tuas sin vuelo', 'gas sin avión', 'ING-12']),
    );
    // AFAC POR VUELO (invariante 90): una fila por vuelo con la CLAVE de la
    // maestra (que ya trae el ID) y su `clave_cliente` copiada de la fila.
    const afac = om.filas.filter((f) => f.seccion === 'AFAC_VUELO');
    expect(afac.map((f) => [f.clave, f.clave_cliente])).toEqual([
      ['#364 · beh05-011026 · Beh Kay ', 'beh05-011026'],
      ['#503 · january02-211026 · January Davila', 'january02-211026'],
    ]);
    expect(om.filas.some((f) => f.seccion === 'AFAC')).toBe(false);
  });

  it('sin ID: «vtbeh364» / «#364 · Beh Kay » como siempre y NINGUNA llave clave_cliente en todo el payload', async () => {
    lectorCon({});
    const g = await general();
    const om = g.consolidado.otros_movimientos;
    // (El #503 no tiene TUAS/extras/comisión ni cobros: no lleva fila aquí.)
    // AFAC POR VUELO (invariante 90): una fila por vuelo con AFAC reservado.
    expect(om.filas.map((f) => f.clave)).toEqual([
      'vtbeh364',
      '#364 · Beh Kay ',
      '#503 · January Davila',
    ]);
    expect(g.consolidado.vuelos.map((v) => v.clave)).toContain(
      '#364 · Beh Kay ',
    );
    expect(JSON.stringify(g)).not.toContain('clave_cliente');
  });

  it('importes, totales, cascada, socios y bloque VUELATOUR IDÉNTICOS con y sin ID', async () => {
    lectorCon(CLAVES);
    const con = await general();
    lectorCon({});
    const sin = await general();
    expect(con.consolidado.vuelos.length).toBe(3);
    expect(sinEtiquetas(con)).toBe(sinEtiquetas(sin));
  });
});
