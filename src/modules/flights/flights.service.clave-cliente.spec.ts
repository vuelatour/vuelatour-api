// Mismos mocks de módulos pesados que el resto de los specs de flights.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pilots/pilots.service', () => ({ PilotsService: class {} }));
// El lector del ID por cliente se reemplaza: aquí se prueba el CABLEADO
// (qué ids pide, dónde pone la llave), no la BD.
jest.mock('../../common/clave-cliente-lectura.util', () => ({
  clavesClienteDeVuelos: jest.fn(),
  vueloIdsPorClaveCliente: jest.fn().mockResolvedValue([]),
}));

import { FlightsService } from './flights.service';
import { clavesClienteDeVuelos } from '../../common/clave-cliente-lectura.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';
import type { ListFlightsQuery } from './dto/flights.dto';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';

/**
 * ID DE VUELO POR CLIENTE (13-oct-2026, API 0.0.75, invariante 68):
 * `clave_cliente` ADITIVO en `GET /v1/flights` (cada fila, SIEMPRE presente)
 * y en el snapshot. Lo arma el lector único (una lectura por página);
 * `findById` (VUELO_COLS, que se usa en escrituras) no cambia.
 */

const lector = clavesClienteDeVuelos as jest.MockedFunction<
  typeof clavesClienteDeVuelos
>;

const V364 = 'aaaaaaaa-0000-4000-8000-000000000364';
const V376 = 'aaaaaaaa-0000-4000-8000-000000000376';
const V166 = 'aaaaaaaa-0000-4000-8000-000000000166';

/** Fila de `vuelo` como la devuelve el select de la lista (con embeds). */
function fila(
  id: string,
  folio: number,
  cliente: string,
): Record<string, unknown> {
  return {
    id,
    folio,
    cliente_id: `cli-${folio}`,
    aeronave_id: 'av-1',
    piloto_id: null,
    copiloto_id: null,
    apoyo_id: null,
    estado: 'CONFIRMADO',
    es_externo: true,
    operador_externo: 'XA-TYV',
    costo_externo_usd: 900,
    costo_externo_monto: 900,
    costo_externo_moneda: 'USD',
    costo_externo_tc: null,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    facturado: false,
    fecha_vuelo: '2026-10-21T14:00:00+00:00',
    aeronave: { matricula: 'XA-VGV', modelo: 'C206' },
    cliente: { nombre: cliente, razon_social_default: null },
    piloto: null,
    copiloto: null,
  };
}

const FILAS = [
  fila(V376, 376, 'January Davila'),
  fila(V364, 364, 'Beh Kay '),
  fila(V166, 166, 'Francisco Encizo'),
];

/**
 * Supabase que devuelve FILAS en la lista de `vuelo` y vacío en todo lo
 * demás (escalas, apoyos, usuarios); `maybeSingle` de `vuelo` = el #376.
 */
function supabase(): SupabaseService {
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'gte',
      'lte',
      'order',
      'limit',
      'range',
    ]) {
      q[m] = () => q;
    }
    q.maybeSingle = () =>
      Promise.resolve({
        data: tabla === 'vuelo' ? FILAS[0] : null,
        error: null,
      });
    q.single = q.maybeSingle;
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(
        tabla === 'vuelo'
          ? { data: FILAS, error: null, count: FILAS.length }
          : { data: [], error: null, count: 0 },
      ).then(res);
    return q;
  };
  return {
    service: { from, storage: { from: () => ({}) } },
  } as unknown as SupabaseService;
}

function servicio(): FlightsService {
  return new FlightsService(
    supabase(),
    {} as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
}

const usuario = (rol: Rol): AuthenticatedUser =>
  ({ userId: 'u-1', rol, nombre: 'X' }) as AuthenticatedUser;

const LISTA = { limit: 50, offset: 0 } as ListFlightsQuery;

type Fila = Record<string, unknown>;

describe('FlightsService.list — clave_cliente (ADITIVO)', () => {
  beforeEach(() => {
    lector.mockReset();
  });

  it('cada fila lleva SU clave; null en las que no tienen', async () => {
    lector.mockResolvedValue(
      new Map([
        [V376, 'january02-211026'],
        [V364, 'beh05-011026'],
      ]),
    );
    const r = await servicio().list(LISTA, usuario(Rol.ADMIN));
    const claves = (r.data as Fila[]).map((f) => [f.folio, f.clave_cliente]);
    expect(claves).toEqual([
      [376, 'january02-211026'],
      [364, 'beh05-011026'],
      [166, null],
    ]);
  });

  it('el lector se llama UNA vez por página, con TODOS los ids', async () => {
    lector.mockResolvedValue(new Map());
    await servicio().list(LISTA, usuario(Rol.ADMIN));
    expect(lector).toHaveBeenCalledTimes(1);
    expect(lector.mock.calls[0][1]).toEqual([V376, V364, V166]);
  });

  it('lector vacío (sin migración / lectura fallida) ⇒ null en todas y el resto de la fila IDÉNTICO', async () => {
    lector.mockResolvedValue(new Map());
    const sin = await servicio().list(LISTA, usuario(Rol.ADMIN));
    lector.mockResolvedValue(new Map([[V376, 'january02-211026']]));
    const con = await servicio().list(LISTA, usuario(Rol.ADMIN));
    for (const f of sin.data as Fila[]) expect(f.clave_cliente).toBeNull();
    const quitar = (d: Fila[]) =>
      d.map((f) => {
        const { clave_cliente: _c, ...resto } = f;
        void _c;
        return resto;
      });
    expect(quitar(con.data as Fila[])).toEqual(quitar(sin.data as Fila[]));
    // La llave va AL FINAL de la fila (después de `servicio`).
    const llaves = Object.keys((con.data as Fila[])[0]);
    expect(llaves.slice(-2)).toEqual(['servicio', 'clave_cliente']);
  });

  it('un PILOTO también la recibe y la redacción de costo_externo_* sigue', async () => {
    lector.mockResolvedValue(new Map([[V376, 'january02-211026']]));
    const r = await servicio().list(LISTA, usuario(Rol.PILOTO));
    const f = (r.data as Fila[])[0];
    expect(f.clave_cliente).toBe('january02-211026');
    for (const k of [
      'costo_externo_usd',
      'costo_externo_monto',
      'costo_externo_moneda',
      'costo_externo_tc',
    ]) {
      expect(f).not.toHaveProperty(k);
    }
  });
});

describe('FlightsService.snapshot / findById — clave_cliente', () => {
  beforeEach(() => {
    lector.mockReset();
  });

  it('snapshot la incluye (junto a cliente_razon_social) y pide SOLO su id', async () => {
    lector.mockResolvedValue(new Map([[V376, 'january02-211026']]));
    const svc = servicio();
    const snap = (await svc.snapshot(V376, usuario(Rol.ADMIN))) as Fila;
    expect(snap.clave_cliente).toBe('january02-211026');
    expect(lector).toHaveBeenCalledTimes(1);
    expect(lector.mock.calls[0][1]).toEqual([V376]);
    const llaves = Object.keys(snap);
    expect(llaves.indexOf('clave_cliente')).toBe(
      llaves.indexOf('cliente_razon_social') + 1,
    );
  });

  it('snapshot con el lector vacío ⇒ clave_cliente null', async () => {
    lector.mockResolvedValue(new Map());
    const snap = (await servicio().snapshot(V376, usuario(Rol.PILOTO))) as Fila;
    expect(snap).toHaveProperty('clave_cliente', null);
  });

  it('findById NO llama al lector (VUELO_COLS sin cambio)', async () => {
    lector.mockResolvedValue(new Map([[V376, 'january02-211026']]));
    const v = (await servicio().findById(V376)) as Fila;
    expect(v.folio).toBe(376);
    expect(v).not.toHaveProperty('clave_cliente');
    expect(lector).not.toHaveBeenCalled();
  });
});
