// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('./pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  fuenteTcLegible: (f: string | null | undefined) =>
    f === 'OPEN_ER_API' ? 'open.er-api' : (f ?? 'TC oficial'),
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));
// Sin la migración del cierre de mes (el eje de siempre).
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));
// El lector del consecutivo por cliente RESPONDE para todos los vuelos (como
// con la migración 20261013000006 aplicada): el documento debe traer el
// número y, aun así, NINGÚN apodo.
jest.mock('../../common/clave-cliente-lectura.util', () => ({
  clavesClienteDeVuelos: jest.fn().mockResolvedValue(new Map()),
  consecutivosClienteDeVuelos: jest.fn(
    (_sb: unknown, ids: ReadonlyArray<string | null | undefined>) =>
      Promise.resolve(
        new Map(
          [...new Set(ids)]
            .filter((id): id is string => typeof id === 'string' && id !== '')
            .map((id, i) => [id, i + 1] as [string, number]),
        ),
      ),
  ),
  vueloIdsPorClaveCliente: jest.fn().mockResolvedValue([]),
}));

import { AircraftBalanceService } from '../aircraft/aircraft-balance.service';
import { DineroReportService } from '../profit-sharing/dinero-report.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceGeneralPayload,
  DineroXlsxPayload,
  RepartoPdfPayload,
} from './pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  INGRESOS_LIBROS,
  fakeSupabase,
  mundoLibros,
} from '../aircraft/libros-pago-vendedor.fixture-spec';
import {
  TC_OFICIAL_PESOS,
  fakeSupabaseReparto,
  mundoPesos,
} from '../profit-sharing/reparto-pesos.fixture-spec';

/**
 * CLAVES SIN APODO EN LOS DOCUMENTOS (23-oct-2026, API 0.0.105, invariante
 * 106). Pedido del cliente: «siempre debemos ocultar los apodos con la clave
 * del vuelo, para dejar solo las columnas de (Num de cotización, nombre
 * completo, fecha, ruta y consecutivo del vuelo)» y «mejor eliminar esos
 * apodos de todos lados». Este spec fija, sobre los payloads que el API
 * manda a pyservices (balance por avión, Balance general con todas sus
 * hojas, Libro Dinero y PDF/XLSX del reparto), que:
 *  - NINGUNA llave `clave_cliente` viaja (ni con el lector respondiendo);
 *  - NINGUNA `clave` tiene forma de ID por cliente («ana02-010926») ni del
 *    legado del libro manual («vtbeh364», «vtbeh», «vtservicio»);
 *  - cada fila de vuelo lleva `cliente`, `consecutivo_cliente` y (donde la
 *    hoja tiene ruta) `ruta`, además de su `folio`/clave «#folio» y fecha.
 * El ID sigue viviendo SOLO en el panel (`flights`/`quotes`): eso no se toca.
 */

/** Forma de un ID por cliente: alias + número (≥ 2 dígitos) + '-DDMMAA'. */
const FORMA_ID = /[a-z]+[0-9]{2,}-[0-9]{6}/;
/** Legado del libro manual: «vt» + nombre («vtbeh364», «vtservicio»). */
const FORMA_LEGADO = /^vt[a-záéíóúüñ]/i;

/** Recorre el payload: todas las `clave` string y todas las llaves vistas. */
function recorrer(
  p: unknown,
  acc = { claves: [] as string[], llaves: new Set<string>() },
) {
  if (Array.isArray(p)) {
    for (const x of p) recorrer(x, acc);
  } else if (p && typeof p === 'object') {
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      acc.llaves.add(k);
      if (k === 'clave' && typeof v === 'string') acc.claves.push(v);
      else recorrer(v, acc);
    }
  }
  return acc;
}

function esperarSinApodos(p: unknown, nombre: string): void {
  const { claves, llaves } = recorrer(p);
  expect(llaves.has('clave_cliente')).toBe(false);
  expect(JSON.stringify(p)).not.toContain('clave_cliente');
  expect(claves.length).toBeGreaterThan(0);
  const conApodo = claves.filter(
    (c) => FORMA_ID.test(c) || FORMA_LEGADO.test(c),
  );
  expect({ documento: nombre, conApodo }).toEqual({
    documento: nombre,
    conApodo: [],
  });
}

/** Una fila de vuelo de un documento: folio, cliente y consecutivo. */
type FilaVuelo = {
  folio?: unknown;
  clave?: string;
  cliente?: string | null;
  consecutivo_cliente?: number | null;
  ruta?: string | null;
};

function esperarColumnasDeVuelo(f: FilaVuelo, conRuta = true): void {
  expect(typeof f.cliente === 'string' || f.cliente === null).toBe(true);
  expect(typeof f.consecutivo_cliente).toBe('number');
  if (conRuta) expect(typeof f.ruta).toBe('string');
}

type General = BalanceGeneralPayload;

function balanceService() {
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const service = new AircraftBalanceService(
    fakeSupabase(mundoLibros(INGRESOS_LIBROS))
      .supabase as unknown as SupabaseService,
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

async function libroDinero(): Promise<DineroXlsxPayload> {
  const service = new DineroReportService(
    fakeSupabase(mundoLibros(INGRESOS_LIBROS))
      .supabase as unknown as SupabaseService,
    {} as never,
  );
  return (
    service as unknown as {
      buildPayload: (d: string, h: string) => Promise<DineroXlsxPayload>;
    }
  ).buildPayload(DESDE, HASTA);
}

async function payloadReparto(): Promise<RepartoPdfPayload> {
  const svc = new ProfitSharingService(
    fakeSupabaseReparto(mundoPesos()).supabase as unknown as SupabaseService,
    {} as never,
    {
      oficialDetallePara: (dia: string) => {
        const tc = TC_OFICIAL_PESOS[dia];
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    {} as never,
  );
  svc.ahora = () => new Date('2026-10-19T15:00:00Z');
  const r = await (
    svc as unknown as {
      buildRepartoPayload: (q: {
        desde: string;
        hasta: string;
      }) => Promise<{ payload: RepartoPdfPayload }>;
    }
  ).buildRepartoPayload({ desde: DESDE, hasta: HASTA });
  return r.payload;
}

describe('Documentos sin apodo (invariante 106): ningún payload a pyservices lleva clave_cliente ni un ID en la clave', () => {
  it('balance por avión: maestra «#folio» con cliente, consecutivo y ruta', async () => {
    const { service, enviados } = balanceService();
    await service.xlsx(AV, DESDE, HASTA);
    const p = enviados.individual!;
    esperarSinApodos(p, 'balance individual');
    expect(p.vuelos.length).toBeGreaterThan(0);
    for (const v of p.vuelos) {
      expect(v.clave).toBe(`#${v.folio}`);
      esperarColumnasDeVuelo(v);
    }
  });

  it('balance general: libros, consolidado FLOTA y «otros movimientos» (filas de vuelo con cliente, consecutivo y ruta; sueltas sin ellas)', async () => {
    const { service, enviados } = balanceService();
    await service.xlsxGeneral(DESDE, HASTA);
    const g = enviados.general!;
    esperarSinApodos(g, 'balance general');
    for (const libro of [g.consolidado, ...g.aviones]) {
      for (const v of libro.vuelos) {
        expect(v.clave).toBe(`#${v.folio}`);
        esperarColumnasDeVuelo(v);
      }
    }
    const om = g.consolidado.otros_movimientos!;
    expect(om.filas.length).toBeGreaterThan(0);
    for (const f of om.filas) {
      expect(f.clave).toMatch(/^#\d+$/);
      esperarColumnasDeVuelo(f);
    }
    for (const f of om.filas_sueltas) {
      expect(f).not.toHaveProperty('cliente');
      expect(f).not.toHaveProperty('consecutivo_cliente');
      expect(f).not.toHaveProperty('ruta');
    }
  });

  it('Libro Dinero: hoja de vuelos y «Otros ingresos» del vuelo', async () => {
    const p = await libroDinero();
    esperarSinApodos(p, 'Libro Dinero');
    expect(p.vuelos.length).toBeGreaterThan(0);
    for (const v of p.vuelos) {
      expect(v.clave).toMatch(/^#\d+/);
      esperarColumnasDeVuelo(v);
    }
    const delVuelo = p.otros_ingresos.filter((f) => f.fecha_vuelo != null);
    expect(delVuelo.length).toBeGreaterThan(0);
    for (const f of delVuelo) {
      expect(f.clave).toMatch(/^#\d+$/);
      esperarColumnasDeVuelo(f);
    }
  });

  it('PDF/XLSX del reparto: cada línea de vuelo lleva consecutivo y ruta junto a folio, cliente y fecha', async () => {
    const p = await payloadReparto();
    esperarSinApodos(p, 'reparto');
    const lineas = p.aviones.flatMap((a) => a.vuelos ?? []);
    expect(lineas.length).toBeGreaterThan(0);
    for (const l of lineas) {
      expect(l.folio).not.toBeNull();
      esperarColumnasDeVuelo(l);
      expect(l).toHaveProperty('fecha');
    }
  });
});
