// Módulos pesados que flights.service importa solo para inyección: se
// sustituyen por clases vacías — notifications arrastra el gateway y `jose`
// (ESM puro, jest no lo transforma); calendar-sync arrastra googleapis;
// vision arrastra el SDK de IA. Mismo patrón que quotes/expenses specs.
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

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FlightsService } from './flights.service';
import type { CreateReservaDto } from './dto/flights.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';

/**
 * `createReserva` como UNA operación idempotente (alta sin internet,
 * 9-sep-2026). Supabase se simula con un builder encadenable que registra
 * las llamadas y resuelve por tabla + operaciones; aquí no se prueba la BD
 * sino el CONTRATO del service: rama idempotente sin re-notificar, huérfano
 * joven → 503, huérfano viejo → reparado, cliente por nombre, detector.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Resultado = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
};
type Llamada = { tabla: string; ops: Op[] };

const METODOS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'or',
  'gte',
  'lte',
  'lt',
  'gt',
  'order',
  'range',
  'limit',
  'insert',
  'update',
  'delete',
];

function fakeSupabase(resolver: (tabla: string, ops: Op[]) => Resultado) {
  const llamadas: Llamada[] = [];
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
          count: r.count ?? null,
        };
      };
      for (const m of METODOS) {
        q[m] = (...args: unknown[]) => {
          ops.push({ m, args });
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(resolve(false));
      q.single = () => Promise.resolve(resolve(false));
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(true)).then(res, rej);
      return q;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, llamadas };
}

const eqDe = (ops: Op[], col: string): unknown =>
  ops.find((o) => o.m === 'eq' && o.args[0] === col)?.args[1];
const tiene = (ops: Op[], m: string): boolean => ops.some((o) => o.m === m);
const esHead = (ops: Op[]): boolean =>
  ops.some(
    (o) =>
      o.m === 'select' && (o.args[1] as { head?: boolean } | undefined)?.head,
  );

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000v1';
const LLAVE = 'aaaaaaaa-0000-4000-8000-00000000cccc';
const AVION = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000b';
const APOYO = 'aaaaaaaa-0000-4000-8000-00000000000c';
const CLIENTE = 'aaaaaaaa-0000-4000-8000-00000000000d';
const CLIENTE_NUEVO = 'aaaaaaaa-0000-4000-8000-00000000000e';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';

function vueloRow(extra: Row = {}): Row {
  return {
    id: V1,
    folio: 118,
    cliente_id: CLIENTE,
    aeronave_id: AVION,
    piloto_id: PILOTO,
    copiloto_id: null,
    apoyo_id: null,
    estado: 'RESERVA',
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    pasajeros: 3,
    fecha_vuelo: '2026-09-14T14:00:00+00:00',
    fecha_fin: '2026-09-14T14:00:00+00:00',
    grupo_id: null,
    client_request_id: LLAVE,
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...extra,
  };
}

interface Mundo {
  /** Fila que devuelve el pre-check por llave (null = no existe). */
  porLlave?: Row | null;
  /** Fila del vuelo por id (rama idempotente / listEscalas). */
  vuelo?: Row | null;
  /** count(escala) de la rama idempotente. */
  nEscalas?: number;
  /** count de cobro/gasto/factura ligados. */
  nDinero?: number;
  /** Escalas que devuelve listEscalas. */
  escalas?: Row[];
  /** Cliente por id (null = no existe). */
  cliente?: Row | null;
  /** Lista de TODOS los clientes (búsqueda por nombre). */
  clientes?: Row[];
  /** Vuelos del detector de duplicados. */
  duplicados?: Row[];
  enTaller?: boolean;
  apoyos?: Row[];
  /** Simula vuelo_apoyo caído (reemplazarApoyos lanza). */
  apoyosError?: boolean;
  /** Discrepancias ALTA abiertas del avión. */
  squawksAlta?: Row[];
}

function armar(m: Mundo) {
  const inserts: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
  const registra = (
    bolsa: Record<string, unknown[]>,
    tabla: string,
    v: unknown,
  ) => {
    (bolsa[tabla] ??= []).push(v);
  };
  const { supabase, llamadas } = fakeSupabase((tabla, ops) => {
    const ins = ops.find((o) => o.m === 'insert');
    const upd = ops.find((o) => o.m === 'update');
    if (ins) registra(inserts, tabla, ins.args[0]);
    if (upd) registra(updates, tabla, upd.args[0]);
    switch (tabla) {
      case 'vuelo':
        if (ins) return { data: m.vuelo ?? vueloRow() };
        if (upd) return { data: null };
        if (eqDe(ops, 'client_request_id') !== undefined)
          return { data: m.porLlave ?? null };
        if (eqDe(ops, 'id') !== undefined) return { data: m.vuelo ?? null };
        if (eqDe(ops, 'cliente_id') !== undefined)
          return { data: m.duplicados ?? [] };
        return { data: [] };
      case 'escala':
        if (ins) return {};
        if (esHead(ops)) return { count: m.nEscalas ?? 0 };
        if (
          ops.some(
            (o) =>
              o.m === 'select' && String(o.args[0]).includes('taco_salida'),
          )
        )
          return { data: m.escalas ?? [] };
        return { data: [] };
      case 'cobro_vuelo':
      case 'gasto':
      case 'factura':
        return esHead(ops) ? { count: m.nDinero ?? 0 } : { data: [] };
      case 'mantenimiento':
        return { data: m.enTaller ? { id: 'm-1' } : null };
      case 'aeronave':
        return tiene(ops, 'in')
          ? { data: [{ id: AVION, matricula: 'XA-VGV', asientos: 9 }] }
          : { data: { matricula: 'XA-VGV' } };
      case 'aeronave_discrepancia':
        return { data: m.squawksAlta ?? [] };
      case 'usuario':
        if (tiene(ops, 'in')) return { data: [] };
        return {
          data: {
            id: eqDe(ops, 'id'),
            estado: 'ACTIVO',
            nombre: 'Juan',
            email: null,
            es_piloto_externo: false,
          },
        };
      case 'cliente':
        if (ins) return { data: { id: CLIENTE_NUEVO } };
        if (upd) return {};
        if (eqDe(ops, 'id') !== undefined) return { data: m.cliente ?? null };
        return { data: m.clientes ?? [] };
      case 'vuelo_apoyo':
        if (m.apoyosError) return { error: { message: 'vuelo_apoyo caído' } };
        if (ins) return {};
        return { data: m.apoyos ?? [] };
      default:
        return {};
    }
  });
  const notifications = {
    notifyUser: jest.fn().mockResolvedValue(true),
    notifyUserDetallado: jest.fn().mockResolvedValue({
      notificado: true,
      push_dispositivos: 1,
      plataformas: ['android'],
    }),
    notifyRole: jest.fn().mockResolvedValue(true),
  } as unknown as NotificationsService;
  const expirations = {
    findBlockingExpirations: jest.fn().mockResolvedValue([]),
  } as unknown as ExpirationsService;
  const refreshPermisos = jest.fn().mockResolvedValue(undefined);
  const airports = {
    refreshPermisosDeVuelo: refreshPermisos,
  } as unknown as AirportsService;
  const calendar = {
    syncFlight: jest.fn().mockResolvedValue(undefined),
  } as unknown as CalendarSyncService;
  const email = {
    sendPilotAssignment: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmailService;
  const service = new FlightsService(
    supabase,
    calendar,
    email,
    {} as VisionService,
    notifications,
    expirations,
    airports,
    {} as ConfiguracionService,
  );
  const notifyPilotAssigned = jest.spyOn(
    service as unknown as { notifyPilotAssigned: () => Promise<unknown> },
    'notifyPilotAssigned',
  );
  return {
    service,
    llamadas,
    inserts,
    updates,
    notifications,
    refreshPermisos,
    notifyPilotAssigned,
  };
}

function dtoBase(extra: Partial<CreateReservaDto> = {}): CreateReservaDto {
  return {
    cliente_id: CLIENTE,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    fecha_vuelo: new Date('2026-09-14T14:00:00Z'),
    fecha_traslado_final: new Date('2026-09-14T20:00:00Z'),
    aeronave_id: AVION,
    piloto_id: PILOTO,
    client_request_id: LLAVE,
    ...extra,
  };
}

const escalasVivas = (): Row[] => [
  {
    id: 'e-1',
    vuelo_id: V1,
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    cancelada_at: null,
  },
  {
    id: 'e-2',
    vuelo_id: V1,
    orden: 2,
    origen_iata: 'HOL',
    destino_iata: 'CUN',
    cancelada_at: null,
  },
];

describe('createReserva — rama idempotente (misma client_request_id)', () => {
  it('segundo POST devuelve el MISMO id/folio con escalas, idempotente:true y NO vuelve a avisar al piloto ni a crear', async () => {
    const w = armar({
      porLlave: { id: V1, estado: 'RESERVA' },
      vuelo: vueloRow(),
      nEscalas: 2,
      escalas: escalasVivas(),
    });
    const r = await w.service.createReserva(dtoBase(), USER);
    expect(r.id).toBe(V1);
    expect(r.folio).toBe(118);
    expect(r.idempotente).toBe(true);
    expect(r.reparado).toBe(false);
    expect(r.cliente_creado).toBe(false);
    expect(r.aviso_piloto).toBeNull();
    expect(r.escalas).toHaveLength(2);
    expect(r.apoyos_aplicados).toBe(false);
    expect(w.notifyPilotAssigned).not.toHaveBeenCalled();
    expect(
      (w.notifications.notifyUserDetallado as jest.Mock).mock.calls,
    ).toHaveLength(0);
    expect(w.inserts.vuelo).toBeUndefined();
    expect(w.inserts.escala).toBeUndefined();
    expect(w.inserts.cliente).toBeUndefined();
  });

  it('con tramos y apoyo_ids: aplica los apoyos SOLO si vuelo_apoyo está vacío (apoyos_aplicados:true), sin re-notificar al piloto', async () => {
    const w = armar({
      porLlave: { id: V1 },
      vuelo: vueloRow(),
      nEscalas: 2,
      escalas: escalasVivas(),
      apoyos: [],
    });
    const r = await w.service.createReserva(
      dtoBase({ apoyo_ids: [APOYO] }),
      USER,
    );
    expect(r.idempotente).toBe(true);
    expect(r.apoyos_aplicados).toBe(true);
    expect(r.apoyos).toEqual([APOYO]);
    expect(w.inserts.vuelo_apoyo).toHaveLength(1);
    expect(w.notifyPilotAssigned).not.toHaveBeenCalled();
  });

  it('con tramos y apoyos YA existentes: no toca vuelo_apoyo (apoyos_aplicados:false)', async () => {
    const w = armar({
      porLlave: { id: V1 },
      vuelo: vueloRow(),
      nEscalas: 2,
      escalas: escalasVivas(),
      apoyos: [
        { id: 'va-1', vuelo_id: V1, escala_id: null, usuario_id: 'otro' },
      ],
    });
    const r = await w.service.createReserva(
      dtoBase({ apoyo_ids: [APOYO] }),
      USER,
    );
    expect(r.apoyos_aplicados).toBe(false);
    expect(r.apoyos).toEqual(['otro']);
    expect(w.inserts.vuelo_apoyo).toBeUndefined();
  });

  it('huérfano JOVEN (< 5 min, sin tramos, sin dinero) → 503 RESERVA_EN_PROCESO y nada se borra', async () => {
    const w = armar({
      porLlave: { id: V1 },
      vuelo: vueloRow({
        created_at: new Date(Date.now() - 60_000).toISOString(),
      }),
      nEscalas: 0,
    });
    let err: unknown;
    try {
      await w.service.createReserva(dtoBase(), USER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(
      (err as ServiceUnavailableException).getResponse() as Record<
        string,
        unknown
      >,
    ).toMatchObject({ error: 'RESERVA_EN_PROCESO' });
    expect(w.inserts.escala).toBeUndefined();
    expect(w.llamadas.some((l) => l.ops.some((o) => o.m === 'delete'))).toBe(
      false,
    );
  });

  it('huérfano VIEJO (> 5 min) → REPARADO: tramos sobre el mismo id/folio, permisos y push al piloto (esta vez sí)', async () => {
    const w = armar({
      porLlave: { id: V1 },
      vuelo: vueloRow({
        created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
      nEscalas: 0,
      escalas: escalasVivas(),
    });
    const r = await w.service.createReserva(dtoBase(), USER);
    expect(r.id).toBe(V1);
    expect(r.folio).toBe(118);
    expect(r.idempotente).toBe(true);
    expect(r.reparado).toBe(true);
    expect(r.escalas).toHaveLength(2);
    // Los tramos del DTO (ida + regreso) se insertaron sobre el MISMO vuelo.
    const legs = w.inserts.escala?.[0] as Row[];
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.vuelo_id === V1)).toBe(true);
    expect(legs[0]).toMatchObject({
      orden: 1,
      origen_iata: 'CUN',
      destino_iata: 'HOL',
    });
    expect(legs[1]).toMatchObject({
      orden: 2,
      origen_iata: 'HOL',
      destino_iata: 'CUN',
    });
    expect(w.inserts.vuelo).toBeUndefined();
    expect(w.refreshPermisos).toHaveBeenCalledWith(V1);
    expect(w.notifyPilotAssigned).toHaveBeenCalledTimes(1);
    expect(r.aviso_piloto).toEqual({
      usuario_id: PILOTO,
      nombre: 'Juan',
      notificado: true,
      push_dispositivos: 1,
    });
    expect(w.llamadas.some((l) => l.ops.some((o) => o.m === 'delete'))).toBe(
      false,
    );
  });

  it('huérfano VIEJO reparado con aceptar_discrepancia_alta → avisa al mecánico del squawk ALTA (el alta original nunca llegó a avisar); el replay CON tramos no', async () => {
    const w = armar({
      porLlave: { id: V1 },
      vuelo: vueloRow({
        created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
      nEscalas: 0,
      escalas: escalasVivas(),
      squawksAlta: [{ id: 'sq-1', descripcion: 'Fuga de aceite' }],
    });
    const squawk = jest
      .spyOn(w.service, 'notificarSquawkAceptado')
      .mockImplementation(() => undefined);
    const r = await w.service.createReserva(
      dtoBase({ aceptar_discrepancia_alta: true }),
      USER,
    );
    expect(r.reparado).toBe(true);
    expect(squawk).toHaveBeenCalledTimes(1);
    expect(squawk.mock.calls[0][1]).toBe(AVION);
    expect(squawk.mock.calls[0][2]).toEqual([
      { id: 'sq-1', descripcion: 'Fuga de aceite' },
    ]);

    // Replay normal (ya con tramos): ni re-valida ni re-avisa a nadie.
    const w2 = armar({
      porLlave: { id: V1 },
      vuelo: vueloRow(),
      nEscalas: 2,
      escalas: escalasVivas(),
      squawksAlta: [{ id: 'sq-1', descripcion: 'Fuga de aceite' }],
    });
    const squawk2 = jest
      .spyOn(w2.service, 'notificarSquawkAceptado')
      .mockImplementation(() => undefined);
    const r2 = await w2.service.createReserva(
      dtoBase({ aceptar_discrepancia_alta: true }),
      USER,
    );
    expect(r2.idempotente).toBe(true);
    expect(squawk2).not.toHaveBeenCalled();
  });

  it('huérfano CON dinero ligado → 200 con el existente y aviso, sin reparar ni borrar', async () => {
    const w = armar({
      porLlave: { id: V1 },
      vuelo: vueloRow(),
      nEscalas: 0,
      nDinero: 1,
    });
    const r = await w.service.createReserva(dtoBase(), USER);
    expect(r.idempotente).toBe(true);
    expect(r.reparado).toBe(false);
    expect(r.avisos).toEqual(['Vuelo sin tramos: revisar en el panel']);
    expect(w.inserts.escala).toBeUndefined();
    expect(w.notifyPilotAssigned).not.toHaveBeenCalled();
  });
});

describe('createReserva — alta fresca', () => {
  it('crea vuelo + tramos con la llave, avisa al piloto con detalle de entrega y responde idempotente:false', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow(),
      cliente: { id: CLIENTE, nombre: 'Juan Pérez', activo: true },
      escalas: escalasVivas(),
    });
    const r = await w.service.createReserva(dtoBase(), USER);
    expect(r.idempotente).toBe(false);
    expect(r.reparado).toBe(false);
    expect(r.cliente_id).toBe(CLIENTE);
    expect(r.cliente_creado).toBe(false);
    expect(r.escalas).toHaveLength(2);
    expect(r.aviso_piloto).toMatchObject({
      usuario_id: PILOTO,
      notificado: true,
    });
    expect(r.aviso_copiloto).toBeNull();
    const payload = w.inserts.vuelo?.[0] as Row;
    expect(payload).toMatchObject({
      cliente_id: CLIENTE,
      client_request_id: LLAVE,
      estado: 'RESERVA',
      created_by: USER,
    });
    expect((w.inserts.escala?.[0] as Row[]).length).toBe(2);
    expect(w.notifyPilotAssigned).toHaveBeenCalledTimes(1);
  });

  it('sin client_request_id el insert NO lleva la columna (panel / APK vieja)', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow({ client_request_id: null }),
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
    });
    await w.service.createReserva(
      dtoBase({ client_request_id: undefined }),
      USER,
    );
    const payload = w.inserts.vuelo?.[0] as Row;
    expect('client_request_id' in payload).toBe(false);
    // Y no hubo pre-check por llave.
    expect(
      w.llamadas.some(
        (l) =>
          l.tabla === 'vuelo' && eqDe(l.ops, 'client_request_id') !== undefined,
      ),
    ).toBe(false);
  });

  it('con cliente_id Y cliente_nombre gana cliente_id: no busca por nombre ni crea', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow(),
      cliente: { id: CLIENTE, nombre: 'Juan Pérez', activo: true },
    });
    const r = await w.service.createReserva(
      dtoBase({ cliente_nombre: 'Otro Nombre' }),
      USER,
    );
    expect(r.cliente_id).toBe(CLIENTE);
    expect(r.cliente_creado).toBe(false);
    expect(w.inserts.cliente).toBeUndefined();
    // La búsqueda por nombre pagina con range(); por id no.
    expect(
      w.llamadas.some((l) => l.tabla === 'cliente' && tiene(l.ops, 'range')),
    ).toBe(false);
  });

  it('cliente_nombre sin coincidencia: se crea JUSTO antes del vuelo, cliente_creado:true y aviso', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow({ cliente_id: CLIENTE_NUEVO }),
      clientes: [{ id: 'c-x', nombre: 'Juana Pérez', activo: true }],
    });
    const r = await w.service.createReserva(
      dtoBase({ cliente_id: undefined, cliente_nombre: '  Juan   Pérez ' }),
      USER,
    );
    expect(r.cliente_id).toBe(CLIENTE_NUEVO);
    expect(r.cliente_creado).toBe(true);
    expect(w.inserts.cliente?.[0]).toMatchObject({
      nombre: 'Juan Pérez',
      created_by: USER,
    });
    expect((w.inserts.vuelo?.[0] as Row).cliente_id).toBe(CLIENTE_NUEVO);
    expect(r.avisos).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Cliente nuevo “Juan Pérez”'),
      ]),
    );
    // El cliente se insertó DESPUÉS de consultar duplicados y ANTES del vuelo.
    const idx = (tabla: string, m: string) =>
      w.llamadas.findIndex((l) => l.tabla === tabla && tiene(l.ops, m));
    expect(idx('cliente', 'insert')).toBeLessThan(idx('vuelo', 'insert'));
  });

  it('cliente_nombre que coincide con un INACTIVO (sin acentos, mayúsculas): se reactiva y se reutiliza', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow(),
      clientes: [{ id: CLIENTE, nombre: 'Juan Pérez', activo: false }],
    });
    const r = await w.service.createReserva(
      dtoBase({ cliente_id: undefined, cliente_nombre: 'JUAN PEREZ' }),
      USER,
    );
    expect(r.cliente_id).toBe(CLIENTE);
    expect(r.cliente_creado).toBe(false);
    expect(w.inserts.cliente).toBeUndefined();
    expect(w.updates.cliente?.[0]).toMatchObject({ activo: true });
  });

  it('cliente_id inexistente → 400 antes de insertar nada', async () => {
    const w = armar({ porLlave: null, cliente: null });
    await expect(
      w.service.createReserva(dtoBase(), USER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(w.inserts.vuelo).toBeUndefined();
  });

  it('posible duplicado con rechazar_posible_duplicado → 409 POSIBLE_DUPLICADO con details.vuelos y SIN crear cliente ni vuelo', async () => {
    const w = armar({
      porLlave: null,
      clientes: [],
      duplicados: [
        vueloRow({ id: 'v-otro', folio: 117, client_request_id: null }),
      ],
    });
    // Para que el detector corra hace falta un cliente existente: por nombre
    // que coincide con uno activo.
    w.llamadas.length = 0;
    const w2 = armar({
      porLlave: null,
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
      duplicados: [
        vueloRow({ id: 'v-otro', folio: 117, client_request_id: null }),
      ],
    });
    let err: unknown;
    try {
      await w2.service.createReserva(
        dtoBase({ rechazar_posible_duplicado: true }),
        USER,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      error: string;
      details: { vuelos: Array<{ folio: number; ruta: string }> };
    };
    expect(body.error).toBe('POSIBLE_DUPLICADO');
    expect(body.details.vuelos[0]).toMatchObject({
      folio: 117,
      ruta: 'CUN → HOL',
    });
    expect(w2.inserts.vuelo).toBeUndefined();
    expect(w2.inserts.cliente).toBeUndefined();
    expect(w.inserts.vuelo).toBeUndefined();
  });

  it('posible duplicado SIN la bandera (panel / APK vieja) → se crea y va como texto en avisos[]', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow(),
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
      duplicados: [vueloRow({ id: 'v-otro', folio: 117 })],
    });
    const r = await w.service.createReserva(dtoBase(), USER);
    expect(r.idempotente).toBe(false);
    expect(r.avisos).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Posible duplicado: #117/),
      ]),
    );
    expect(w.inserts.vuelo).toHaveLength(1);
  });

  it('aceptar_posible_duplicado anula el rechazo', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow(),
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
      duplicados: [vueloRow({ id: 'v-otro', folio: 117 })],
    });
    const r = await w.service.createReserva(
      dtoBase({
        rechazar_posible_duplicado: true,
        aceptar_posible_duplicado: true,
      }),
      USER,
    );
    expect(r.idempotente).toBe(false);
    expect(w.inserts.vuelo).toHaveLength(1);
  });

  it('avión en taller → 409 ESTRUCTURADO AERONAVE_EN_TALLER con el message de siempre, antes de tocar nada', async () => {
    const w = armar({ porLlave: null, enTaller: true });
    let err: unknown;
    try {
      await w.service.createReserva(dtoBase(), USER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      message:
        'No se puede asignar: la aeronave está en taller (mantenimiento en curso).',
      error: 'AERONAVE_EN_TALLER',
      details: { aeronave_id: AVION, matricula: 'XA-VGV' },
    });
    expect(w.inserts.vuelo).toBeUndefined();
  });

  it('capturado_en válido y viejo se sella en notas_internas; uno inválido NUNCA rechaza', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow(),
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
    });
    // Un instante del PASADO real (el sello compara contra el reloj del
    // servidor): 1-sep-2026 09:00 Cancún.
    await w.service.createReserva(
      dtoBase({
        notas_internas: 'Nota',
        capturado_en: '2026-09-01T09:00:00-05:00',
      }),
      USER,
    );
    expect(String((w.inserts.vuelo?.[0] as Row).notas_internas)).toMatch(
      /^Nota\n\[Capturado en la app el 1 sep 09:00 · recibido el /,
    );
    const w2 = armar({
      porLlave: null,
      vuelo: vueloRow(),
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
    });
    const r = await w2.service.createReserva(
      dtoBase({ capturado_en: 'ayer' }),
      USER,
    );
    expect(r.idempotente).toBe(false);
    expect(String((w2.inserts.vuelo?.[0] as Row).notas_internas)).toMatch(
      /no confiable: ayer/,
    );
  });

  it('sin aeronave_id → 400 claro ANTES de tocar nada (hecho duro: la reserva propia siempre lleva avión)', async () => {
    const w = armar({
      porLlave: null,
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
    });
    await expect(
      w.service.createReserva(dtoBase({ aeronave_id: undefined }), USER),
    ).rejects.toThrow(/Elige la aeronave/);
    expect(w.inserts.vuelo).toBeUndefined();
    expect(w.inserts.cliente).toBeUndefined();
  });

  it('si los apoyos fallan DESPUÉS de los tramos: el piloto YA fue avisado (la rama idempotente jamás re-avisa), el error es 500 transitorio y nada se borra', async () => {
    const w = armar({
      porLlave: null,
      vuelo: vueloRow(),
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
      apoyosError: true,
    });
    await expect(
      w.service.createReserva(dtoBase({ apoyo_ids: [APOYO] }), USER),
    ).rejects.toThrow(/vuelo_apoyo caído/);
    expect(w.inserts.vuelo).toHaveLength(1);
    expect(w.inserts.escala).toHaveLength(1);
    expect(w.notifyPilotAssigned).toHaveBeenCalledTimes(1);
    expect(w.llamadas.some((l) => l.ops.some((o) => o.m === 'delete'))).toBe(
      false,
    );
  });

  it('23505 sobre uq_vuelo_client_request en el insert (carrera) → rama idempotente sin duplicar', async () => {
    let intento = 0;
    const base = armar({
      porLlave: null,
      vuelo: vueloRow(),
      nEscalas: 2,
      escalas: escalasVivas(),
      cliente: { id: CLIENTE, nombre: 'Juan', activo: true },
    });
    // Reemplaza el resolver de `vuelo`: el pre-check no encuentra nada, el
    // insert choca con el índice único y la relectura por llave sí encuentra.
    const original = base.service as unknown as {
      supabase: { service: { from: (t: string) => unknown } };
    };
    const fromOriginal = original.supabase.service.from.bind(
      original.supabase.service,
    );
    original.supabase.service.from = (tabla: string) => {
      const q = fromOriginal(tabla) as Record<string, unknown>;
      if (tabla !== 'vuelo') return q;
      const insertOriginal = q.insert as (...a: unknown[]) => unknown;
      q.insert = (...a: unknown[]) => {
        insertOriginal(...a);
        q.maybeSingle = () =>
          Promise.resolve({
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "uq_vuelo_client_request"',
            },
          });
        return q;
      };
      const eqOriginal = q.eq as (...a: unknown[]) => unknown;
      q.eq = (...a: unknown[]) => {
        eqOriginal(...a);
        if (a[0] === 'client_request_id') {
          intento += 1;
          q.maybeSingle = () =>
            Promise.resolve({
              data: intento === 1 ? null : { id: V1 },
              error: null,
            });
        }
        return q;
      };
      return q;
    };
    const r = await base.service.createReserva(dtoBase(), USER);
    expect(r.id).toBe(V1);
    expect(r.idempotente).toBe(true);
    expect(base.notifyPilotAssigned).not.toHaveBeenCalled();
  });
});
