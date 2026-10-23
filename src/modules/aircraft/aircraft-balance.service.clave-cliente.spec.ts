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
// El lector del consecutivo por cliente se reemplaza: aquí se prueban SOLO
// las columnas de identificación de las filas (la BD del lector tiene su
// propio spec).
jest.mock('../../common/clave-cliente-lectura.util', () => ({
  clavesClienteDeVuelos: jest.fn().mockResolvedValue(new Map()),
  consecutivosClienteDeVuelos: jest.fn(),
  vueloIdsPorClaveCliente: jest.fn().mockResolvedValue([]),
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import { consecutivosClienteDeVuelos } from '../../common/clave-cliente-lectura.util';
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
 * CLAVES SIN APODO EN LOS LIBROS DEL BALANCE (23-oct-2026, API 0.0.105,
 * invariante 106). Pedido del cliente: «siempre debemos ocultar los apodos
 * con la clave del vuelo, para dejar solo las columnas de (Num de
 * cotización, nombre completo, fecha, ruta y consecutivo del vuelo)». SOLO
 * ETIQUETAS: la CLAVE de la maestra/cobranza y de «otros movimientos» es el
 * folio «#364» (`claveLibro` / `claveOtrosMovimientos`), ninguna fila lleva
 * `clave_cliente` ni un texto con forma de ID, y cada fila de vuelo trae
 * `cliente` (nombre completo), `fecha`, `ruta` y `consecutivo_cliente` (el
 * número del vuelo dentro de su cliente; null si el lector no lo da).
 * Ningún importe, T.C., partición ni total cambia.
 *
 * Mundo: el de los libros con el vuelo #501 re-etiquetado como el #364 de
 * prod (cliente «Beh Kay », con su espacio), tarifa AFAC en el XB-TST, un
 * segundo avión XB-DOS y el #503 MULTI-AVIÓN de «January Davila» (un tramo
 * en cada avión).
 */

const lector = consecutivosClienteDeVuelos as jest.MockedFunction<
  typeof consecutivosClienteDeVuelos
>;

const AV2 = 'av-2';
const V3 = 'v-3';
const CONSECUTIVOS: Record<string, number> = { [V1]: 5, [V3]: 2 };

/** Forma de un ID por cliente («beh05-011026», «ana02-010926»). */
const FORMA_ID = /[a-z]+[0-9]{2,}-[0-9]{6}/;
/** Forma del legado del libro manual («vtbeh364», «vtbeh», «vtservicio»). */
const FORMA_LEGADO = /^vt[a-záéíóúüñ]/i;

/** El lector: SOLO los consecutivos de los ids pedidos (como el real). */
function lectorCon(consecutivos: Record<string, number>) {
  lector.mockImplementation((_sb, ids) =>
    Promise.resolve(
      new Map(
        [...new Set(ids)]
          .filter((id): id is string => !!id && consecutivos[id] != null)
          .map((id) => [id, consecutivos[id]] as [string, number]),
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
      // Tarifa AFAC: las filas AFAC_VUELO copian las columnas de la maestra.
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
 * El payload sin lo ÚNICO que el lector cambia (`consecutivo_cliente`) ni
 * los sellos: con y sin lector debe ser IDÉNTICO.
 */
const sinConsecutivo = (p: unknown) =>
  JSON.stringify(p, (llave: string, valor: unknown) =>
    llave === 'consecutivo_cliente' || llave === 'generado' ? undefined : valor,
  );

/** Todas las `clave` (string) de cualquier profundidad del payload. */
function claves(p: unknown, out: string[] = []): string[] {
  if (Array.isArray(p)) {
    for (const x of p) claves(x, out);
  } else if (p && typeof p === 'object') {
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (k === 'clave' && typeof v === 'string') out.push(v);
      else claves(v, out);
    }
  }
  return out;
}

/** Ni `clave_cliente` ni un texto con forma de ID o de legado en las claves. */
function esperarSinApodos(p: unknown): void {
  expect(JSON.stringify(p)).not.toContain('clave_cliente');
  const todas = claves(p);
  expect(todas.length).toBeGreaterThan(0);
  for (const c of todas) {
    expect(c).not.toMatch(FORMA_ID);
    expect(c).not.toMatch(FORMA_LEGADO);
  }
}

describe('Balance por avión — CLAVE sin apodo (invariante 106)', () => {
  beforeEach(() => lector.mockReset());

  it('hoja maestra (y cobranza, misma fila): clave «#364», cliente completo, fecha, ruta y consecutivo en sus columnas', async () => {
    lectorCon(CONSECUTIVOS);
    const p = await individual();
    const f364 = p.vuelos.find((v) => v.vuelo_id === V1)!;
    expect(f364.clave).toBe('#364');
    expect(f364.cliente).toBe('Beh Kay ');
    expect(f364.consecutivo_cliente).toBe(5);
    expect(f364.fecha).toBe('2026-09-10');
    expect(f364.ruta).toBe('CUN-MID');
    // El consecutivo va JUNTO al cliente (no al final: las últimas llaves
    // de la fila siguen siendo las de las comisiones / el cierre).
    const llaves = Object.keys(f364);
    expect(llaves.indexOf('consecutivo_cliente')).toBe(
      llaves.indexOf('cliente') + 1,
    );
    esperarSinApodos(p);
    // El lector se pidió UNA vez con los vuelos del libro.
    expect(lector).toHaveBeenCalledTimes(1);
    expect([...(lector.mock.calls[0][1] as string[])].sort()).toEqual(
      [V1, V3].sort(),
    );
  });

  it('lector vacío (sin migración o lectura fallida) ⇒ la MISMA clave «#364» y consecutivo_cliente: null en cada fila', async () => {
    lectorCon({});
    const p = await individual();
    const f364 = p.vuelos.find((v) => v.vuelo_id === V1)!;
    expect(f364.clave).toBe('#364');
    expect(f364.cliente).toBe('Beh Kay ');
    for (const v of p.vuelos) {
      expect(v).toHaveProperty('consecutivo_cliente', null);
    }
    esperarSinApodos(p);
  });

  it('ningún número cambia: con y sin lector el libro es idéntico fuera del consecutivo', async () => {
    lectorCon(CONSECUTIVOS);
    const con = await individual();
    lectorCon({});
    const sin = await individual();
    expect(con.vuelos.length).toBeGreaterThan(0);
    expect(sinConsecutivo(con)).toBe(sinConsecutivo(sin));
  });
});

describe('Balance GENERAL — claves sin apodo en libros, consolidado y «otros movimientos»', () => {
  beforeEach(() => lector.mockReset());

  it('la MISMA clave «#folio» en aviones[] y en el consolidado FLOTA; multi-avión: el mismo folio, cliente y consecutivo en las filas de los dos libros', async () => {
    lectorCon(CONSECUTIVOS);
    const g = await general();
    const porLibro = Object.fromEntries(
      g.aviones.map((p) => [
        p.matricula,
        p.vuelos.map((v) => [v.clave, v.cliente, v.consecutivo_cliente]),
      ]),
    );
    expect(porLibro['XB-DOS']).toEqual([['#503', 'January Davila', 2]]);
    expect(porLibro['XB-TST']).toEqual(
      expect.arrayContaining([
        ['#364', 'Beh Kay ', 5],
        ['#503', 'January Davila', 2],
      ]),
    );
    const flota = g.consolidado.vuelos.map((v) => [
      v.clave,
      v.cliente,
      v.consecutivo_cliente,
    ]);
    expect(flota).toHaveLength(3);
    expect(flota.filter((c) => c[0] === '#503')).toHaveLength(2);
    expect(flota).toContainEqual(['#364', 'Beh Kay ', 5]);
    esperarSinApodos(g);
  });

  it('«otros movimientos»: «#364» + cliente, consecutivo y ruta (también tras COLAPSAR varias líneas del vuelo); sueltas sin esas llaves; AFAC_VUELO las copia de la maestra', async () => {
    lectorCon(CONSECUTIVOS);
    const g = await general();
    const om = g.consolidado.otros_movimientos;
    const f364 = om.filas.find(
      (f) => f.clave === '#364' && f.seccion === undefined,
    )!;
    expect(f364.cliente).toBe('Beh Kay ');
    expect(f364.consecutivo_cliente).toBe(5);
    expect(f364.ruta).toBe('CUN-MID');
    expect(f364.fecha_vuelo).toBe('2026-09-10');
    // El #364 trae TUAS + comisión + extras: la fila es la COLAPSADA.
    expect(f364.concepto_ingreso).toContain('conceptos (ver nota)');
    // Sueltas (TUAS sin vuelo, gas sin avión, ING-n): sin las llaves del vuelo.
    for (const f of om.filas_sueltas) {
      expect(f).not.toHaveProperty('cliente');
      expect(f).not.toHaveProperty('consecutivo_cliente');
      expect(f).not.toHaveProperty('ruta');
    }
    expect(om.filas_sueltas.map((f) => f.clave)).toEqual(
      expect.arrayContaining(['tuas sin vuelo', 'gas sin avión', 'ING-12']),
    );
    // AFAC POR VUELO (invariante 90): una fila por vuelo con la CLAVE «#folio»
    // y el cliente / consecutivo / ruta de la fila de la maestra; `afac`
    // sigue siendo la ÚLTIMA llave.
    const afac = om.filas.filter((f) => f.seccion === 'AFAC_VUELO');
    expect(
      afac.map((f) => [f.clave, f.cliente, f.consecutivo_cliente]),
    ).toEqual([
      ['#364', 'Beh Kay ', 5],
      ['#503', 'January Davila', 2],
    ]);
    expect(afac[0].ruta).toBe('CUN-MID');
    expect(afac[1].ruta).toContain('CUN-MID-CUN');
    for (const f of afac) expect(Object.keys(f).at(-1)).toBe('afac');
    expect(om.filas.some((f) => f.seccion === 'AFAC')).toBe(false);
    esperarSinApodos(g);
  });

  it('sin lector: las mismas claves «#364» / «#503» (ya no «vtbeh364» ni «#364 · Beh Kay ») y consecutivo_cliente: null en todas las filas de vuelo', async () => {
    lectorCon({});
    const g = await general();
    const om = g.consolidado.otros_movimientos;
    // (El #503 no tiene TUAS/extras/comisión ni cobros: no lleva fila aquí.)
    // AFAC POR VUELO (invariante 90): una fila por vuelo con AFAC reservado.
    expect(om.filas.map((f) => f.clave)).toEqual(['#364', '#364', '#503']);
    expect(om.filas.map((f) => f.consecutivo_cliente)).toEqual([
      null,
      null,
      null,
    ]);
    expect(om.filas.map((f) => f.cliente)).toEqual([
      'Beh Kay ',
      'Beh Kay ',
      'January Davila',
    ]);
    expect(g.consolidado.vuelos.map((v) => v.clave)).toContain('#364');
    for (const v of g.consolidado.vuelos) {
      expect(v).toHaveProperty('consecutivo_cliente', null);
    }
    esperarSinApodos(g);
  });

  it('importes, totales, cascada, socios y bloque VUELATOUR IDÉNTICOS con y sin lector', async () => {
    lectorCon(CONSECUTIVOS);
    const con = await general();
    lectorCon({});
    const sin = await general();
    expect(con.consolidado.vuelos.length).toBe(3);
    expect(sinConsecutivo(con)).toBe(sinConsecutivo(sin));
  });
});
